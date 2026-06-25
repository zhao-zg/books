# Runtime Behavior Matrix

| Environment | Back behavior | TTS | Download APK | Install PWA | Cache buttons |
|---|---|---|---|---|---|
| Web Browser | Browser history/default | Web Speech API | Android only | If install prompt available | Yes (if SW available) |
| Installed PWA | popstate to app-defined route | Web Speech API | No | No | Yes |
| Capacitor App | App.backButton hooks | Capacitor TTS (if installed) or fallback | No | No | Yes |

## Page type routing

- `home`: back -> exit
- `directory`: back -> home
- `content`: back -> directory
