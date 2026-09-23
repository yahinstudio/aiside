# 从一张源图生成扩展图标 16/48/128（.NET System.Drawing 内置，无需额外依赖）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File tools\gen_icons.ps1
#   powershell -ExecutionPolicy Bypass -File tools\gen_icons.ps1 -Source C:\path\to\logo.png
#
# 默认读取仓库根目录下的 logo.png，输出覆盖仓库根目录的 icons\。
# 源图不在仓库内（需自行准备），建议使用 512x512 以上的方形 PNG/JPG。
# 注意：仅 Windows 可用。

param(
    [string]$Source,
    [string]$OutDir
)

$ErrorActionPreference = "Stop"

# 相对仓库根目录定位，便于在任何机器上克隆后直接运行
$root = Split-Path -Parent $PSScriptRoot
if (-not $Source) { $Source = Join-Path $root "logo.png" }
if (-not $OutDir) { $OutDir = Join-Path $root "icons" }

if (-not (Test-Path -LiteralPath $Source)) {
    Write-Host "找不到源图：$Source"
    Write-Host "请用 -Source 指定一张方形图片，例如："
    Write-Host "  powershell -ExecutionPolicy Bypass -File tools\gen_icons.ps1 -Source .\logo.png"
    exit 1
}
if (-not (Test-Path -LiteralPath $OutDir)) {
    New-Item -ItemType Directory -Path $OutDir | Out-Null
}

Add-Type -AssemblyName System.Drawing

$src = [System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $Source).Path)
Write-Host ("source image: {0} ({1}x{2})" -f $Source, $src.Width, $src.Height)

try {
    foreach ($size in @(16, 48, 128)) {
        $bmp = New-Object System.Drawing.Bitmap($size, $size)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $g.Clear([System.Drawing.Color]::Transparent)
        $g.DrawImage($src, 0, 0, $size, $size)
        $out = Join-Path $OutDir "icon$size.png"
        $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
        $g.Dispose()
        $bmp.Dispose()
        Write-Host "generated $out"
    }
} finally {
    $src.Dispose()
}
