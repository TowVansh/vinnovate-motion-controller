// Minimal service worker so the pad installs as an app. Network first: the pad is useless offline anyway.
self.addEventListener('fetch', () => {});
