@echo off
setlocal
cd /d "%~dp0client"
echo Configure JAVA_HOME, ANDROID_HOME and optionally VITE_API_BASE before building.
call npm run build
if errorlevel 1 exit /b 1
call npx cap sync android
if errorlevel 1 exit /b 1
cd android
call gradlew.bat assembleDebug
