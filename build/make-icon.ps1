# Build build/icon.ico: rounded gradient tile with a white CJK glyph (U+756A, "fan")
# System.Drawing draws a 256x256 PNG, then the ICO container is written by hand
# (Vista+ ICO files may embed a PNG payload directly).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$size = 256
$glyph = [string][char]0x756A   # the character we want, kept as a codepoint to stay ASCII-safe

$bmp = New-Object System.Drawing.Bitmap $size, $size
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.TextRenderingHint = 'AntiAliasGridFit'
$g.Clear([System.Drawing.Color]::Transparent)

$r = 56
$d = $r * 2
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddArc(0, 0, $d, $d, 180, 90)
$path.AddArc($size - $d, 0, $d, $d, 270, 90)
$path.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
$path.AddArc(0, $size - $d, $d, $d, 90, 90)
$path.CloseFigure()

$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.Point 0, 0),
  (New-Object System.Drawing.Point $size, $size),
  [System.Drawing.ColorTranslator]::FromHtml('#7c9cff'),
  [System.Drawing.ColorTranslator]::FromHtml('#ff8fb1'))
$g.FillPath($brush, $path)

$glossH = 256
$gloss = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.Point 0, 0),
  (New-Object System.Drawing.Point 0, $glossH),
  [System.Drawing.Color]::FromArgb(70, 255, 255, 255),
  [System.Drawing.Color]::FromArgb(0, 255, 255, 255))
$g.FillPath($gloss, $path)

$font = New-Object System.Drawing.Font('Microsoft YaHei', 132, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$fmt = New-Object System.Drawing.StringFormat
$fmt.Alignment = 'Center'
$fmt.LineAlignment = 'Center'
$rect = New-Object System.Drawing.RectangleF 0, 6, $size, $size
$shadow = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(60, 0, 0, 0))
$g.DrawString($glyph, $font, $shadow, (New-Object System.Drawing.RectangleF 2, 10, $size, $size), $fmt)
$white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
$g.DrawString($glyph, $font, $white, $rect, $fmt)
$g.Dispose()

$pngPath = Join-Path $PSScriptRoot 'icon-256.png'
$bmp.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

$pngBytes = [System.IO.File]::ReadAllBytes($pngPath)
$icoPath = Join-Path $PSScriptRoot 'icon.ico'
$fs = [System.IO.File]::Create($icoPath)
$bw = New-Object System.IO.BinaryWriter $fs
$bw.Write([UInt16]0)
$bw.Write([UInt16]1)
$bw.Write([UInt16]1)
$bw.Write([Byte]0)
$bw.Write([Byte]0)
$bw.Write([Byte]0)
$bw.Write([Byte]0)
$bw.Write([UInt16]1)
$bw.Write([UInt16]32)
$bw.Write([UInt32]$pngBytes.Length)
$bw.Write([UInt32]22)
$bw.Write($pngBytes)
$bw.Flush(); $bw.Dispose(); $fs.Dispose()

Write-Output "png=$pngPath ($((Get-Item $pngPath).Length) bytes)"
Write-Output "ico=$icoPath ($((Get-Item $icoPath).Length) bytes)"

