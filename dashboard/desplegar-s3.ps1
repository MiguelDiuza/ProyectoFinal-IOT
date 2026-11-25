# Compila el dashboard y lo sube al bucket de S3 (sitio web estático).
# Requisitos: Node 20+, AWS CLI y las credenciales del Learner Lab cargadas
# (AWS Details -> AWS CLI -> pegar en ~/.aws/credentials; caducan cada 4 h).
#
# Uso:
#   .\desplegar-s3.ps1 -Bucket bodega-cafe-dashboard-jorge -Api https://xxxx.execute-api.us-east-1.amazonaws.com
#   .\desplegar-s3.ps1 -Bucket ... -Api ... -SinCompilar   # sube el dist/ que ya existe
param(
  [Parameter(Mandatory = $true)][string]$Bucket,
  [Parameter(Mandatory = $true)][string]$Api,
  [string]$Region = 'us-east-1',
  [switch]$SinCompilar
)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if ($Api -notmatch '^https://') { throw "La URL de la API debe empezar por https:// (es la Invoke URL de API Gateway)." }
$Api = $Api.TrimEnd('/')

if (-not $SinCompilar) {
  npm ci
  if ($LASTEXITCODE -ne 0) { throw 'npm ci falló' }
  npm run build
  if ($LASTEXITCODE -ne 0) { throw 'npm run build falló' }
}
if (-not (Test-Path dist/index.html)) { throw 'No existe dist/index.html: compila primero.' }

# config.js con la URL real de la API (se puede volver a editar en S3 sin recompilar)
@"
// Generado por desplegar-s3.ps1
window.BODEGA_CONFIG = {
  api: '$Api',
  modo: 'serverless',
  sondeoSeg: 5,
};
"@ | Out-File -Encoding utf8 dist/config.js

# Los assets llevan hash en el nombre: caché larga. index.html y config.js: siempre frescos.
aws s3 sync dist "s3://$Bucket" --region $Region --delete --exclude index.html --exclude config.js --cache-control 'public,max-age=31536000,immutable'
aws s3 cp dist/index.html "s3://$Bucket/index.html" --region $Region --cache-control 'no-cache' --content-type 'text/html; charset=utf-8'
aws s3 cp dist/config.js "s3://$Bucket/config.js" --region $Region --cache-control 'no-cache' --content-type 'application/javascript; charset=utf-8'
if ($LASTEXITCODE -ne 0) { throw 'La subida a S3 falló (¿credenciales del Learner Lab vencidas?)' }

Write-Host ""
Write-Host "Listo: http://$Bucket.s3-website-$Region.amazonaws.com" -ForegroundColor Green
