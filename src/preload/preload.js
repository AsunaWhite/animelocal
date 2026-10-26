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
});
