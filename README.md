# WMS Viewer

A browser-based WMS Explorer for loading WMS GetCapabilities endpoints, selecting layers, and previewing model data on a Leaflet map. The app supports common WMS options such as styles, image formats, time/depth dimensions, opacity, color scale ranges, palettes, and feature info requests when the selected layer is queryable.

## Requirements

- A modern web browser
- Internet access for external map tiles, Leaflet assets, and WMS services
- PHP 7.4 or newer for the local development server and `proxy.php` CORS fallback

No Node.js dependencies, package installation, or build step are required.

## Run Locally

From the project directory, start PHP's built-in web server:

```powershell
php -S localhost:8000
```

Then open:

```text
http://localhost:8000
```

The app loads `index.html`, `styles.css`, and `app.js` directly. Running through a local server is recommended because the viewer can use `proxy.php` when direct browser requests to a WMS server are blocked by CORS.

## Using The App

1. Paste a WMS service URL or GetCapabilities URL into the WMS URL field.
2. Click **Load**.
3. Choose a layer, style, format, time, depth/elevation, and rendering options.
4. Click **Apply To Map** to refresh the WMS overlay.
5. Click the map to request feature info for queryable layers.

## Project Files

- `index.html` - main app markup and Leaflet includes
- `styles.css` - app layout and visual styling
- `app.js` - WMS parsing, map behavior, controls, legends, and feature info
- `proxy.php` - local proxy used when direct WMS requests are blocked
