# Etsy Product Creator - SIFIRDAN kurulum (mevcut sil + yeniden yukle)
# .env, config.json ve etsy/pinterest oturumu OTOMATIK yedeklenir/restore edilir.
#
# Kullanim:
#   iwr -useb https://raw.githubusercontent.com/esenbora/etsy-product-creator/main/fresh.ps1 | iex

$ErrorActionPreference = 'Continue'

$T = if ($env:TARGET) { $env:TARGET } else { Join-Path $HOME "etsy-product-creator" }
$B = Join-Path $env:TEMP "epc-fresh-backup"

Write-Host "=== SIFIRDAN KURULUM ===" -ForegroundColor Magenta
Write-Host "Hedef: $T"
Write-Host ""

# 1. Yedek
Write-Host "[1/5] Mevcut .env / config.json / etsy oturumu yedekleniyor..." -ForegroundColor Cyan
Remove-Item $B -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $B -Force | Out-Null
foreach ($f in @(".env", "config.json", "mockup-positions.json")) {
  if (Test-Path "$T\$f") {
    Copy-Item "$T\$f" "$B\$f" -Force
    Write-Host "  yedeklendi: $f"
  }
}
if (Test-Path "$T\data\cdp-profile") {
  Copy-Item "$T\data\cdp-profile" "$B\cdp-profile" -Recurse -Force
  Write-Host "  yedeklendi: data\cdp-profile (etsy + pinterest oturumu)"
}

# 2. Calisan process kapat
Write-Host "[2/5] Calisan server / browser kapatiliyor..." -ForegroundColor Cyan
foreach ($port in @(3000, 9333)) {
  Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue | ForEach-Object {
    try { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } catch { }
  }
}
Start-Sleep -Seconds 2

# 3. Eski masaustu kisayollarini sil (her olasi yere)
Write-Host "[3/5] Eski masaustu ikonlari siliniyor..." -ForegroundColor Cyan
$desktopPaths = @(
  [Environment]::GetFolderPath('Desktop'),
  "$HOME\Desktop",
  "$HOME\OneDrive\Desktop"
) | Sort-Object -Unique
foreach ($d in $desktopPaths) {
  if (Test-Path $d) {
    Get-ChildItem $d -Filter "Etsy*" -ErrorAction SilentlyContinue | ForEach-Object {
      Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
      Write-Host "  silindi: $($_.FullName)"
    }
  }
}

# 4. Klasoru sil
Write-Host "[4/5] Eski klasor siliniyor..." -ForegroundColor Cyan
if (Test-Path $T) {
  # Salt-okunur dosyalar / git objeleri icin -Force
  Remove-Item $T -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path $T) {
    # Hala duruyorsa cmd ile dene
    cmd /c "rmdir /s /q `"$T`"" 2>&1 | Out-Null
  }
  if (Test-Path $T) {
    Write-Host "HATA: $T silinemedi (acik dosya?). Bilgisayari yeniden baslat ve tekrar dene." -ForegroundColor Red
    return
  }
  Write-Host "  silindi: $T"
}

# 5. repair.ps1 ile yeniden kur
Write-Host "[5/5] Yeniden kurulum (repair.ps1)..." -ForegroundColor Cyan
try {
  $repair = Invoke-WebRequest -UseBasicParsing -Uri "https://raw.githubusercontent.com/esenbora/etsy-product-creator/main/repair.ps1"
  Invoke-Expression $repair.Content
} catch {
  Write-Host "HATA: repair.ps1 indirilemedi/calistirilamadi: $_" -ForegroundColor Red
  return
}

# 6. Yedekleri restore et
Write-Host ""
Write-Host "[+] Yedekler geri yukleniyor..." -ForegroundColor Cyan
foreach ($f in @(".env", "config.json", "mockup-positions.json")) {
  if (Test-Path "$B\$f") {
    Copy-Item "$B\$f" "$T\$f" -Force
    Write-Host "  restore: $f"
  }
}
if (Test-Path "$B\cdp-profile") {
  if (-not (Test-Path "$T\data")) { New-Item -ItemType Directory -Path "$T\data" -Force | Out-Null }
  Copy-Item "$B\cdp-profile" "$T\data\cdp-profile" -Recurse -Force
  Write-Host "  restore: data\cdp-profile (etsy + pinterest oturumu korundu)"
}

Remove-Item $B -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "=== FRESH INSTALL TAMAM ===" -ForegroundColor Green
Write-Host ""
Write-Host "Masaustunde 'Etsy Creator.bat' var mi kontrol et." -ForegroundColor Yellow
Write-Host "Cift tik -> baslar." -ForegroundColor Yellow
Write-Host ""
Write-Host "Eger .env eski yedekten geldiyse API key'ler korundu."
Write-Host "Eger ilk kez yukluyorsan: notepad $T\.env ile doldur"
