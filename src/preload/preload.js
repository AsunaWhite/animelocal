'use strict';

/**
 * preload 桥
 * ------------------------------------------------------------
 * 界面上能用的「系统能力」都在这里登记。
 * 渲染进程没有 Node，只能用 window.api.xxx —— 白名单式暴露，安全。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  /** 环境信息：版本号、用户数据目录等 */
  getAppInfo: () => ipcRenderer.invoke('app:info'),

  /**
   * 拿某个季度的番剧表（默认当季）。
   * @param {{season?: string, force?: boolean}} opts
   */
  loadSeason: (opts = {}) => ipcRenderer.invoke('catalog:load', opts),

  /**
   * 勾上 / 取消勾上「这部我本地有」，主进程会立刻写进 library.json。
   * @param {{season?: string, id: string, owned: boolean}} payload
   */
  toggleOwned: (payload) => ipcRenderer.invoke('library:toggle', payload),

  /** 弹系统对话框，让用户选资源目录 */
  pickScanDir: () => ipcRenderer.invoke('scan:pick'),

  /** 开扫：扫完返回结果；扫的过程中会通过 onScanProgress 推进度 */
  runScan: (payload = {}) => ipcRenderer.invoke('scan:run', payload),

  /** 上次的扫描结果 */
  getScanState: () => ipcRenderer.invoke('scan:state'),

  /** 手动把某个文件指派给某部动画 */
  assignFile: (payload) => ipcRenderer.invoke('scan:assign', payload),

  /** 清空本季度的识别记忆（认错太多时的急救按钮） */
  forgetAliases: () => ipcRenderer.invoke('scan:forget'),

  /**
   * 播放某一集：主进程校验路径后交给系统默认播放器。
   * 传的是扫描结果里的绝对路径，主进程会再核一遍（只认扫描过的文件）。
   * @param {{path: string}} payload
   */
  playFile: (payload) => ipcRenderer.invoke('play:file', payload),

  /**
   * 订阅扫描进度。返回取消订阅的函数（页面卸载时调一下）。
   * 这是 IPC 的第三种姿势：主进程主动 push，不是渲染进程问一次答一次。
   */
  onScanProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('scan:progress', handler);
    return () => ipcRenderer.removeListener('scan:progress', handler);
  },
});
