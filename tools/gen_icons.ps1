# 用用户提供的 D:\logo.png 生成扩展图标 16/48/128（System.Drawing 内置，无需额外依赖）
# 用法：powershell -ExecutionPolicy Bypass -File tools\gen_icons.ps1

Add-Type -AssemblyName System.Drawing

$src = [System.Drawing.Image]::FromFile("D:\logo.png")
Write-Host ("source image: {0}x{1}" -f $src.Width, $src.Height)

foreach ($size in @(16, 48, 128)) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.DrawImage($src, 0, 0, $size, $size)
    $out = "E:\aiside\icons\icon$size.png"
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose()
    $bmp.Dispose()
    Write-Host "generated $out"
}

$src.Dispose()
