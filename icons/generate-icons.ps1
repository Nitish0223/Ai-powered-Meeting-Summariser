Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Drawing.Drawing2D

$basePath = "e:/simples web projects/Ai-powered-Meeting-Summariser/extension/icons"
$sizes = @(16, 32, 48, 128)

foreach ($size in $sizes) {
    $bitmap = New-Object System.Drawing.Bitmap($size, $size)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)

    $rect = [System.Drawing.RectangleF]::new(0, 0, $size, $size)
    $startColor = [System.Drawing.Color]::FromArgb(255, 30, 120, 210)
    $endColor = [System.Drawing.Color]::FromArgb(255, 70, 200, 180)
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $startColor, $endColor, 45)
    $graphics.FillRectangle($brush, $rect)
    $brush.Dispose()

    $fontSize = [Math]::Max(6, [Math]::Floor($size / 3))
    $font = New-Object System.Drawing.Font('Segoe UI', $fontSize, [System.Drawing.FontStyle]::Bold)
    $textBrush = [System.Drawing.Brushes]::White
    $format = New-Object System.Drawing.StringFormat
    $format.Alignment = 'Center'
    $format.LineAlignment = 'Center'

    $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
    $graphics.DrawString('AI', $font, $textBrush, $rect, $format)

    $font.Dispose()
    $graphics.Dispose()

    $outputPath = Join-Path $basePath ("icon-$size.png")
    $bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Dispose()
}
