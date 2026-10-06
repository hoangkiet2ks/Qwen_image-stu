import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.aiphoto.app',
  appName: 'AI Photo Editor',
  webDir: 'dist',
  bundledWebRuntime: false,

  android: {
    backgroundColor: '#060b16',
    allowMixedContent: true,
  },

  // Kết nối đến AI server (ComfyUI proxy)
  server: {
    // The UI is bundled inside the APK. API traffic is configured separately
    // in src/api.js and points to the PC on the local network.
    hostname: 'localhost',
    port: 3000,
    androidScheme: 'http',
  },

  plugins: {},
};

export default config;
