# ⚡️ ultimate-file-tool

**Project still in development**

A sleek, modern and **100% offline** desktop toolbox built with **Electron**. Convert, compress, edit, secure and organize images, videos, audio, PDFs, documents, spreadsheets, data files and archives, plus a media downloader. Nothing is ever uploaded: every tool runs locally on your machine.

**109 tools · 11 categories · 170+ file formats**

---

## Features

* **Drag & drop anywhere:** drop files on the home screen to instantly see every tool that can handle them, or drop them straight into a tool.
* **Batch everything:** process hundreds of files at once with live progress and cancel.
* **Search (Ctrl+K):** find any tool by name, action or format (`heic`, `mp4 to mp3`, `merge pdf`…).
* **Smart defaults:** each tool remembers your last options; save results next to the originals or in a fixed folder.
* **Favorites, history and notifications** for long jobs running in the background.
* **Preview before applying** for destructive tools (rename, organize, duplicates, find & replace…).

### 🖼️ Images (16)
Convert (JPG, PNG, WebP, AVIF, TIFF, GIF, BMP, ICO; reads HEIC, SVG, PSD, TGA, DDS, EXR, QOI…), compress, resize, smart crop, rotate & flip, filters & adjustments, watermark (text or logo), remove EXIF/GPS metadata, favicon & app icon generator, image to Base64, image info & EXIF, color palette extraction, combine/collage, split into tiles, borders & rounded corners, images to GIF/WebP/MP4.

### 🎬 Video (15)
Convert (MP4, MKV, WebM, MOV, AVI, WMV, FLV, MPEG, OGV, 3GP, TS…), compress (quality level or exact target size, H.264/H.265), trim, video to GIF/WebP, extract audio, remove audio, resize, crop to 9:16 / 1:1 / 4:5, change speed, rotate, extract frames & contact sheets, merge clips, replace or mix music, embed subtitles, media info.

### 🎵 Audio (12)
Convert (MP3, M4A, WAV, FLAC, OGG, Opus, AAC, ALAC, AIFF, WMA, AC3, M4R ringtones), compress, trim with fades, loudness normalization & gain, tempo & pitch, merge with crossfade, effects (reverse, bass boost, echo, reverb, 8D, karaoke, telephone, denoise…), remove silence, split, waveform & spectrogram images, audio to video, edit tags & cover art.

### 📕 PDF (15)
Merge, split, extract pages, delete pages, rotate, reorder (reverse, custom, duplex scan collation), images to PDF, PDF to images, PDF to text, compress, watermark, page numbers, edit metadata, flatten forms, PDF info.

### 📝 Documents (8)
Convert Markdown, HTML, Word (DOCX) and TXT to PDF, DOCX, HTML, Markdown or text; text encoding converter (UTF-8, UTF-16, Windows-1252, Latin-1, Shift_JIS, GBK…); line endings & whitespace; word & character count; find & replace across files (regex); merge text files; change case; subtitle converter & sync (SRT, VTT, ASS).

### 📊 Data & Sheets (9)
Convert spreadsheets (XLSX, XLS, XLSB, ODS, Numbers, CSV, TSV, JSON to Excel, ODS, CSV, JSON, HTML, Markdown, SQL or PDF), spreadsheet viewer, JSON / YAML / XML / TOML / CSV / JSON Lines / INI converter, JSON formatter & validator, clean CSV, merge CSV, split CSV, merge workbooks, split workbook.

### 📦 Archives (5)
Create ZIP, 7Z, TAR, TAR.GZ (with optional AES-256 password), extract (ZIP, 7Z, TAR, TGZ, TAR.BZ2, TAR.XZ, GZ, BZ2, XZ, CAB, ZST, JAR, APK, EPUB, CBZ…), list contents, convert between formats, GZip / Brotli / Zstandard.

### 🔐 Security (6)
Encrypt / decrypt files (AES-256-GCM + scrypt), checksums (MD5, SHA-1, SHA-256, SHA-384, SHA-512, RIPEMD-160, CRC32), verify a checksum, compare two files, secure delete (shred).

### 🌍 Web & Download (4)
Media downloader powered by [yt-dlp](https://github.com/yt-dlp/yt-dlp) (YouTube and 1000+ sites, playlists, MP3, subtitles; downloaded automatically on first use), direct file downloader, web page to PDF, website screenshot (full page, desktop or mobile).

### 🗂️ File Manager (13)
Bulk rename (patterns, numbering, dates, regex), find duplicates, folder size analyzer, auto-organize a folder, split / join large files, file info & real type detection, hex viewer, export file list, remove empty folders, flatten folder, change file dates, fix wrong extensions.

### 🧰 Utilities (6)
QR code generator (text, Wi-Fi, email, phone), QR code reader, Base64 encode/decode, password & passphrase generator, UUID / NanoID generator, text hashing & encoding.

---

## Installation

This project requires **Node.js 20+** and **npm**.

1.  **Clone the repository:**

    ```bash
    git clone https://github.com/GLOXIOU/ultimate-file-tool
    ```

2.  **Install dependencies:**

    ```bash
    npm install
    ```

    If Electron fails to start with "Electron failed to install correctly", run `node node_modules/electron/install.js`.

3.  **Run the app:**

    ```bash
    npm start
    ```

---

## Usage

1.  **Pick a tool** from the sidebar, the home screen or the search bar (Ctrl+K), or simply drop files on the window.
2.  **Add files** by dropping them or clicking the drop zone (folders are scanned too).
3.  **Adjust the options**, then click the action button.
4.  **Open the results** directly from the result panel or from the History page.

---

## Project structure

```
main.js                 Electron main process, IPC and job runner
preload.js              Secure bridge exposed to the UI (window.api)
lib/core/               ffmpeg, 7-Zip, PDF rendering, downloads, helpers
lib/tools/<category>.js Tool definitions (metadata + handler) per category
lib/crypter-manager/    AES-256-GCM file encryption
src/                    UI (single page app: index.html, css/, js/)
```

Adding a tool means adding one object to a file in `lib/tools/`: its options are declared once and the UI form is generated automatically.

---

## Building the App

Package the app into an installer with **electron-builder**:

```bash
npm run build        # current platform
npm run build:win    # Windows installer + portable .exe
npm run build:mac
npm run build:linux
```

Output goes to `dist/`.
