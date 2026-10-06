$ErrorActionPreference = 'Stop'

function Stop-ExpectedListener {
    param(
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string]$ExpectedCommandPattern
    )

    $listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
        Select-Object -First 1

    if (-not $listener) {
        Write-Host "- $Label da tat." -ForegroundColor DarkGray
        return
    }

    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
    $commandLine = [string]$processInfo.CommandLine

    if ($commandLine -notmatch $ExpectedCommandPattern) {
        Write-Host "- Khong tat cong ${Port}: $($processInfo.Name) khong phai tien trinh AI cua app." -ForegroundColor Yellow
        return
    }

    Stop-Process -Id $listener.OwningProcess -Force
    Write-Host "- Da tat $Label (cong $Port)." -ForegroundColor Green
}

Write-Host ''
Write-Host 'Dang tat dich vu AI cua Qwen Image Editor...' -ForegroundColor Cyan

# Chi tat Tailscale Serve cho app; Tailscale van dang dang nhap de dung cho viec khac.
$tailscaleExe = $null
if ($env:TAILSCALE_EXE -and (Test-Path -LiteralPath $env:TAILSCALE_EXE)) {
    $tailscaleExe = $env:TAILSCALE_EXE
} else {
    $tailscaleCommand = Get-Command tailscale.exe -ErrorAction SilentlyContinue
    if ($tailscaleCommand) {
        $tailscaleExe = $tailscaleCommand.Source
    }
}

if ($tailscaleExe) {
    try {
        & $tailscaleExe serve --https=443 off | Out-Null
        Write-Host '- Da dong duong truy cap Tailscale vao app.' -ForegroundColor Green
    } catch {
        Write-Host '- Khong dong duoc Tailscale Serve, ban co the kiem tra lai sau.' -ForegroundColor Yellow
    }
} else {
    Write-Host '- Khong tim thay Tailscale; bo qua buoc nay.' -ForegroundColor Yellow
}

# Chi dung dung frontend, proxy Node va ComfyUI cua app, tranh tat nham dich vu khac.
Stop-ExpectedListener -Port 5174 -Label 'web frontend' -ExpectedCommandPattern '(?i)vite'
Stop-ExpectedListener -Port 3000 -Label 'backend proxy' -ExpectedCommandPattern '(?i)server\.js'
Stop-ExpectedListener -Port 8188 -Label 'ComfyUI AI' -ExpectedCommandPattern '(?i)(ComfyUI|main\.py)'

Write-Host ''
Write-Host 'Hoan tat. Anh, model va file cau hinh khong bi xoa.' -ForegroundColor Cyan
