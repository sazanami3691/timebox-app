Add-Type -AssemblyName System.Drawing

$repoRoot = Split-Path -Parent $PSScriptRoot
$iconsDirectory = Join-Path $repoRoot "icons"
New-Item -ItemType Directory -Force -Path $iconsDirectory | Out-Null

function New-RoundedRectanglePath {
    param(
        [System.Drawing.RectangleF]$Rectangle,
        [single]$Radius
    )

    $diameter = $Radius * 2
    $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $path.AddArc($Rectangle.X, $Rectangle.Y, $diameter, $diameter, 180, 90)
    $path.AddArc($Rectangle.Right - $diameter, $Rectangle.Y, $diameter, $diameter, 270, 90)
    $path.AddArc($Rectangle.Right - $diameter, $Rectangle.Bottom - $diameter, $diameter, $diameter, 0, 90)
    $path.AddArc($Rectangle.X, $Rectangle.Bottom - $diameter, $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    return $path
}

function Save-TimeboxIcon {
    param(
        [int]$Size,
        [string]$FileName
    )

    $bitmap = [System.Drawing.Bitmap]::new($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.Clear([System.Drawing.ColorTranslator]::FromHtml("#0d1117"))

    $panelBrush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml("#171d25"))
    $lightPen = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml("#d5d9e2"), [single]($Size * 0.045))
    $greenPen = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml("#4ca565"), [single]($Size * 0.055))
    $handPen = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml("#f1f3f5"), [single]($Size * 0.04))
    $dotBrush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml("#4ca565"))

    $lightPen.StartCap = $lightPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $greenPen.StartCap = $greenPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $handPen.StartCap = $handPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round

    $frame = [System.Drawing.RectangleF]::new([single]($Size * 0.205), [single]($Size * 0.16), [single]($Size * 0.59), [single]($Size * 0.68))
    $framePath = New-RoundedRectanglePath -Rectangle $frame -Radius ([single]($Size * 0.105))
    $graphics.FillPath($panelBrush, $framePath)
    $graphics.DrawPath($lightPen, $framePath)

    $clock = [System.Drawing.RectangleF]::new([single]($Size * 0.315), [single]($Size * 0.275), [single]($Size * 0.37), [single]($Size * 0.37))
    $graphics.DrawEllipse($greenPen, $clock)
    $center = [System.Drawing.PointF]::new([single]($Size * 0.5), [single]($Size * 0.46))
    $graphics.DrawLine($handPen, $center, [System.Drawing.PointF]::new([single]($Size * 0.5), [single]($Size * 0.345)))
    $graphics.DrawLine($handPen, $center, [System.Drawing.PointF]::new([single]($Size * 0.59), [single]($Size * 0.515)))
    $graphics.FillEllipse($dotBrush, [single]($Size * 0.465), [single]($Size * 0.425), [single]($Size * 0.07), [single]($Size * 0.07))

    $graphics.DrawLine($greenPen, [single]($Size * 0.34), [single]($Size * 0.735), [single]($Size * 0.66), [single]($Size * 0.735))

    $outputPath = Join-Path $iconsDirectory $FileName
    $bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)

    $framePath.Dispose()
    $panelBrush.Dispose()
    $lightPen.Dispose()
    $greenPen.Dispose()
    $handPen.Dispose()
    $dotBrush.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
}

Save-TimeboxIcon -Size 180 -FileName "apple-touch-icon.png"
Save-TimeboxIcon -Size 192 -FileName "icon-192.png"
Save-TimeboxIcon -Size 512 -FileName "icon-512.png"

Write-Output "Generated icons in $iconsDirectory"
