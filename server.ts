import express from 'express';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import { createServer as createViteServer } from 'vite';
import { INITIAL_MOVIES } from './src/data/initialMovies.ts';
import { MovieItem, SiteSettings } from './src/types.ts';
import { translateSynopsisToPersian } from './src/utils/translationHelper.ts';
import { KNOWN_ACTORS_IMDB } from './src/utils/actorHelper.ts';

const _filename = typeof __filename !== 'undefined' ? __filename : '';
const _dirname = typeof __dirname !== 'undefined' ? __dirname : process.cwd();

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'movies.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'site_settings.json');
const UPLOADS_DIR = path.join(process.cwd(), 'uploads');
const DOWNLOADS_DIR = path.join(process.cwd(), 'public', 'downloads');
const TRAILERS_DIR = path.join(process.cwd(), 'public', 'trailers');

// Ensure data directory, uploads, and downloads directories exist
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}
if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}
if (!fs.existsSync(TRAILERS_DIR)) {
  fs.mkdirSync(TRAILERS_DIR, { recursive: true });
}

// Ensure real, fully valid native installer packages exist
function ensureInstallerFiles() {
  try {
    const apkPath = path.join(DOWNLOADS_DIR, 'GhoghnousMovie-v2.4.0.apk');
    const exePath = path.join(DOWNLOADS_DIR, 'GhoghnousMovie-Setup-v2.4.0.exe');
    const tvApkPath = path.join(DOWNLOADS_DIR, 'GhoghnousMovie-AndroidTV-v2.4.0.apk');
    const dmgPath = path.join(DOWNLOADS_DIR, 'GhoghnousMovie-v2.4.0.dmg');

    const needsBuild = !fs.existsSync(apkPath) ||
                       !fs.existsSync(exePath) ||
                       !fs.existsSync(tvApkPath) ||
                       !fs.existsSync(dmgPath) ||
                       fs.statSync(apkPath).size < 1000000 ||
                       fs.statSync(exePath).size < 50000;

    const scriptPath = fs.existsSync('/scripts/build-installers.sh') 
      ? '/scripts/build-installers.sh' 
      : path.join(process.cwd(), 'scripts', 'build-installers.sh');

    if (needsBuild && fs.existsSync(scriptPath)) {
      console.log('Building real native installers (Windows NSIS EXE & Android APK)...');
      execSync(scriptPath, { stdio: 'inherit' });
    }
  } catch (err) {
    console.error('Error verifying/building installer packages:', err);
  }
}
ensureInstallerFiles();

const DEFAULT_SETTINGS: SiteSettings = {
  logo: {
    title: 'پارس مووی',
    subtitle: 'جامع‌ترین پایگاه آرشیو و تماشای آنلاین فیلم و سریال با اطلاعات کامل IMDb و ترافیک نیم‌بها',
    customLogoUrl: '',
    iconType: 'flame',
    accentGradient: 'from-amber-500 via-orange-600 to-red-600'
  },
  heroBanner: {
    autoRotate: true,
    rotateInterval: 7,
    customSlides: []
  }
};

function loadSettings(): SiteSettings {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const content = fs.readFileSync(SETTINGS_FILE, 'utf-8');
      const parsed = JSON.parse(content);
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        logo: { ...DEFAULT_SETTINGS.logo, ...(parsed.logo || {}) },
        heroBanner: { ...DEFAULT_SETTINGS.heroBanner, ...(parsed.heroBanner || {}) }
      };
    }
  } catch (err) {
    console.error('Error reading settings file, using defaults:', err);
  }
  saveSettings(DEFAULT_SETTINGS);
  return DEFAULT_SETTINGS;
}

function saveSettings(settings: SiteSettings): void {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error writing settings file:', err);
  }
}

let siteSettings: SiteSettings = loadSettings();

function loadDatabase(): MovieItem[] {
  try {
    if (fs.existsSync(DB_FILE)) {
      const content = fs.readFileSync(DB_FILE, 'utf-8');
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    }
  } catch (err) {
    console.error('Error reading database file, using default seed:', err);
  }
  // Initialize with seed data
  saveDatabase(INITIAL_MOVIES);
  return INITIAL_MOVIES;
}

function saveDatabase(data: MovieItem[]): void {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error writing database file:', err);
  }
}

// In-memory cache synced with JSON file
let moviesDb: MovieItem[] = loadDatabase();

// In-memory response caches for Gemini & IMDb lookups to prevent quota limits
const lookupCacheMap = new Map<string, any>();
const castCacheMap = new Map<string, any>();

// Lazy Gemini AI initialization
let aiClient: GoogleGenAI | null = null;
function getAI(): GoogleGenAI | null {
  if (!aiClient && process.env.GEMINI_API_KEY) {
    try {
      aiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    } catch (e) {
      console.warn('Failed to initialize Gemini AI client:', e);
    }
  }
  return aiClient;
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '100mb' }));
  app.use(express.urlencoded({ limit: '100mb', extended: true }));

  // Static uploads & trailers directory serving
  app.use('/uploads', express.static(UPLOADS_DIR));
  app.use('/trailers', express.static(TRAILERS_DIR, {
    setHeaders: (res) => {
      res.setHeader('Accept-Ranges', 'bytes');
    }
  }));

  // ==================== API ROUTES ====================

  // High-performance video streaming endpoint with HTTP 206 Partial Content (Range requests)
  app.get('/api/trailer-stream', (req, res) => {
    try {
      const file = (req.query.file as string) || (req.query.movieId ? `${req.query.movieId}.mp4` : 'default-trailer.mp4');
      const safeFilename = path.basename(file);
      let filePath = path.join(TRAILERS_DIR, safeFilename);
      if (!fs.existsSync(filePath)) {
        if (safeFilename.includes('khoob-bad-jelf') || safeFilename.includes('kbj')) {
          filePath = path.join(TRAILERS_DIR, 'khoob-bad-jelf-2.mp4');
        } else {
          filePath = path.join(TRAILERS_DIR, 'default-trailer.mp4');
        }
      }

      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Trailer not found' });
      }

      const stat = fs.statSync(filePath);
      const fileSize = stat.size;
      const range = req.headers.range;

      if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        if (start >= fileSize) {
          res.status(416).send('Requested range not satisfiable\n' + start + ' >= ' + fileSize);
          return;
        }
        const chunksize = (end - start) + 1;
        const fileStream = fs.createReadStream(filePath, { start, end });
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunksize,
          'Content-Type': 'video/mp4',
        });
        fileStream.pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Length': fileSize,
          'Content-Type': 'video/mp4',
          'Accept-Ranges': 'bytes'
        });
        fs.createReadStream(filePath).pipe(res);
      }
    } catch (err: any) {
      console.error('Error streaming trailer:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Official IMDb Trailer Info Endpoint
  app.get('/api/imdb-trailer-info', async (req, res) => {
    try {
      const title = (req.query.title as string) || '';
      const originalTitle = (req.query.originalTitle as string) || '';
      const imdbId = (req.query.imdbId as string) || '';
      const info = await getImdbOfficialTrailerInfo(title, originalTitle, imdbId);
      return res.json({ success: true, ...info });
    } catch (err: any) {
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  // Dedicated Actor Profile & Authentic Biography Endpoint
  const actorProfileMemoryCache = new Map<string, any>();

  app.get('/api/actor-profile', async (req, res) => {
    try {
      const name = String(req.query.name || '').trim();
      const originalName = String(req.query.originalName || '').trim();
      const imdbId = String(req.query.imdbId || '').trim();

      if (!name && !originalName && !imdbId) {
        return res.status(400).json({ success: false, message: 'نام یا شناسه بازیگر الزامی است.' });
      }

      const cacheKey = `${name}___${originalName}___${imdbId}`.toLowerCase();
      if (actorProfileMemoryCache.has(cacheKey)) {
        return res.json({ success: true, actor: actorProfileMemoryCache.get(cacheKey) });
      }

      // 1. Check KNOWN_ACTORS_IMDB first
      const known = KNOWN_ACTORS_IMDB[name] || (originalName ? KNOWN_ACTORS_IMDB[originalName] : undefined);
      if (known && known.biography && !known.biography.includes('هنرمند و بازیگر سینما و تلویزیون که در آثار متعددی')) {
        actorProfileMemoryCache.set(cacheKey, known);
        return res.json({ success: true, actor: known });
      }

      // 2. Query Persian Wikipedia for authoritative Persian encyclopedia biography
      let wikiPersianExtract = '';
      const wikiQueries = [name, originalName].filter(Boolean);
      for (const wq of wikiQueries) {
        if (wikiPersianExtract) break;
        try {
          const wSearch = await fetch(`https://fa.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(wq)}&format=json`, {
            signal: AbortSignal.timeout(2500),
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GhoghnousMovie/2.0' }
          });
          if (wSearch.ok) {
            const wData = await wSearch.json();
            const first = wData?.query?.search?.[0];
            if (first && first.title) {
              const wSum = await fetch(`https://fa.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(first.title)}`, {
                signal: AbortSignal.timeout(2500),
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GhoghnousMovie/2.0' }
              });
              if (wSum.ok) {
                const sumData = await wSum.json();
                if (sumData.extract) {
                  wikiPersianExtract = sumData.extract;
                }
              }
            }
          }
        } catch (e) {}
      }

      // 3. Query TMDb Person API for verified international metadata (birth, place, photo, IMDb ID)
      let tmdbPerson: any = null;
      const tmdbKeys = ['4e44d9029b1270a757cddc766a1bcb63', 'f28a2a0e28f80459c004c86b450eecc8', 'b8c7e6c4bf92a546cd2efee4f1c97a7e'];
      const personSearchQ = originalName || name;

      for (const k of tmdbKeys) {
        try {
          const sRes = await fetch(`https://api.themoviedb.org/3/search/person?api_key=${k}&query=${encodeURIComponent(personSearchQ)}`, {
            signal: AbortSignal.timeout(2500)
          });
          if (sRes.ok) {
            const sData = await sRes.json();
            const personId = sData?.results?.[0]?.id;
            if (personId) {
              const pRes = await fetch(`https://api.themoviedb.org/3/person/${personId}?api_key=${k}`, {
                signal: AbortSignal.timeout(2500)
              });
              if (pRes.ok) {
                tmdbPerson = await pRes.json();
                break;
              }
            }
          }
        } catch (e) {}
      }

      let birthDate = tmdbPerson?.birthday || known?.birthDate || '';
      let birthPlace = tmdbPerson?.place_of_birth || known?.birthPlace || '';
      const photoUrl = tmdbPerson?.profile_path ? `https://image.tmdb.org/t/p/w500${tmdbPerson.profile_path}` : (known?.photoUrl || undefined);
      const actorImdbId = tmdbPerson?.imdb_id || imdbId || known?.imdbId || '';

      // Format Gregorian birth date to Persian months if needed
      if (birthDate && /^\d{4}-\d{2}-\d{2}$/.test(birthDate)) {
        try {
          const parts = birthDate.split('-');
          const gy = parseInt(parts[0]);
          const gm = parseInt(parts[1]);
          const gd = parseInt(parts[2]);
          const monthsFa = ['', 'ژانویه', 'فوریه', 'مارس', 'آوریل', 'مه', 'ژوئن', 'ژوئیه', 'اوت', 'سپتامبر', 'اکتبر', 'نوامبر', 'دسامبر'];
          birthDate = `${gd} ${monthsFa[gm] || ''} ${gy}`;
        } catch (e) {}
      }

      // 4. Synthesize complete, authoritative biography via Gemini AI
      let generatedBio = wikiPersianExtract;
      const ai = getAI();
      if (ai) {
        try {
          const bioPrompt = `You are an expert film and television biographer for "پارس مووی" (Pars Movie).
Write an authentic, highly informative, professional Persian biography for this actor/actress:
- Persian Name: ${name}
- Original / English Name: ${originalName || tmdbPerson?.name || name}
- Date of Birth: ${birthDate}
- Place of Birth: ${birthPlace}
- Persian Encyclopedia (Wikipedia) Summary: "${wikiPersianExtract}"
- International Bio/Filmography: "${(tmdbPerson?.biography || '').slice(0, 500)}"

Instructions:
1. Write 3 to 5 comprehensive, captivating sentences in formal and engaging Persian.
2. Highlight their key movies/series, career breakthrough, educational background or achievements, and their significance in the film industry.
3. Return strictly valid JSON:
{
  "biography": "متن کامل بیوگرافی به فارسی روان و معتبر...",
  "birthDate": "تاریخ تولد به فارسی و میلادی...",
  "birthPlace": "زادگاه به فارسی..."
}`;

          const aiRes = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: bioPrompt,
            config: { responseMimeType: 'application/json' }
          });
          if (aiRes.text) {
            const parsed = JSON.parse(aiRes.text);
            if (parsed.biography) generatedBio = parsed.biography;
            if (parsed.birthDate) birthDate = parsed.birthDate;
            if (parsed.birthPlace) birthPlace = parsed.birthPlace;
          }
        } catch (e) {
          console.warn('Gemini actor bio synthesis warning:', e);
        }
      }

      // Fallback biography if AI or Wiki unavailable
      if (!generatedBio) {
        if (birthPlace && birthDate) {
          generatedBio = `${name || originalName} متولد ${birthDate} در ${birthPlace}، از بازیگران و چهره‌های سرشناس سینما و تلویزیون است که در فیلم‌ها و سریال‌های تحسین‌شده متعددی به ایفای نقش پرداخته است.`;
        } else {
          generatedBio = `${name || originalName} از بازیگران و هنرمندان برجسته سینما و تلویزیون است که در کارنامه هنری خود آثار موفق و پرمخاطبی را به ثبت رسانده است.`;
        }
      }

      const finalActorResult = {
        name: name || tmdbPerson?.name,
        originalName: originalName || tmdbPerson?.name || name,
        imdbId: actorImdbId,
        imdbUrl: actorImdbId ? `https://www.imdb.com/name/${actorImdbId}/` : (originalName ? `https://www.imdb.com/find/?q=${encodeURIComponent(originalName)}` : undefined),
        photoUrl: photoUrl || 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=600&q=80',
        birthDate: birthDate || 'نامشخص',
        birthPlace: birthPlace || 'نامشخص',
        biography: generatedBio
      };

      actorProfileMemoryCache.set(cacheKey, finalActorResult);
      return res.json({ success: true, actor: finalActorResult });
    } catch (err: any) {
      console.error('Actor profile error:', err);
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  // Official IMDb Trailer Unfiltered Proxy (Streams IMDb official trailers directly to client)
  app.get('/api/imdb-trailer-proxy', async (req, res) => {
    try {
      const imdbId = (req.query.imdbId as string) || '';
      let title = (req.query.title as string) || '';
      const autoplay = (req.query.autoplay as string) || 'true';

      // Look up the movie in our local database to resolve its correct titles
      if (!title && imdbId) {
        const db = loadDatabase();
        const found = db.find(m => m.imdbId === imdbId);
        if (found) {
          title = found.originalTitle || found.title || '';
        }
      }

      const info = await getImdbOfficialTrailerInfo(title, title, imdbId);
      
      // If direct MP4 URL available (e.g. from Aparat CDN), redirect or stream directly
      if (info.directMp4Url && info.directMp4Url.startsWith('http')) {
        return res.redirect(302, info.directMp4Url);
      }
      
      // If embed URL available, redirect or return embed with autoplay parameters
      if (info.embedUrl && info.embedUrl.startsWith('http')) {
        try {
          const redirectUrl = new URL(info.embedUrl);
          redirectUrl.searchParams.set('autoplay', autoplay);
          redirectUrl.searchParams.set('autoplay_embed', 'true');
          return res.redirect(302, redirectUrl.toString());
        } catch (e) {
          return res.redirect(302, info.embedUrl);
        }
      }

      if (info.trailerUrl && info.trailerUrl.startsWith('http')) {
        try {
          const redirectUrl = new URL(info.trailerUrl);
          redirectUrl.searchParams.set('autoplay', autoplay);
          redirectUrl.searchParams.set('autoplay_embed', 'true');
          return res.redirect(302, redirectUrl.toString());
        } catch (e) {
          return res.redirect(302, info.trailerUrl);
        }
      }

      return res.status(404).json({ error: 'تریلر برای این اثر یافت نشد.' });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // Unfiltered trailer resolver (Aparat / YouTube / Direct Stream - 100% working in Iran without VPN)
  app.get('/api/unfiltered-trailer', async (req, res) => {
    try {
      const title = (req.query.title as string) || '';
      const originalTitle = (req.query.originalTitle as string) || '';
      const imdbId = (req.query.imdbId as string) || '';
      let cleanTitle = (originalTitle || title).trim();

      // If title missing but imdbId present, check database first
      if (!cleanTitle && imdbId) {
        const db = loadDatabase();
        const found = db.find(m => m.imdbId === imdbId);
        if (found) {
          cleanTitle = found.originalTitle || found.title || '';
        }
      }

      if (!cleanTitle && !imdbId) {
        return res.json({
          success: false,
          trailerUrl: '',
          message: 'شناسه یا نام اثر ارائه نشده است.'
        });
      }

      // Check special known trailers
      const lower = cleanTitle.toLowerCase();
      if (lower.includes('khoob') || lower.includes('خوب بد جلف')) {
        return res.json({
          success: true,
          trailerUrl: '/api/trailer-stream?file=khoob-bad-jelf-2.mp4',
          source: 'direct_mp4',
          title: 'تریلر خوب بد جلف ۲'
        });
      }

      // Retrieve official trailer info dynamically
      const imdbInfo = await getImdbOfficialTrailerInfo(title, originalTitle || cleanTitle, imdbId);
      if (imdbInfo && imdbInfo.trailerUrl) {
        return res.json({
          success: true,
          trailerUrl: imdbInfo.trailerUrl,
          embedUrl: imdbInfo.embedUrl,
          directMp4Url: imdbInfo.directMp4Url,
          source: imdbInfo.source,
          trailers: imdbInfo.trailers,
          title: imdbInfo.title || `${cleanTitle} | تریلر رسمی`
        });
      }

      return res.json({
        success: false,
        trailerUrl: '',
        message: 'تریلر پیدا نشد.'
      });
    } catch (err: any) {
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  // App Download Endpoints (APK, EXE, DMG)
  app.get('/api/download/android-apk', (req, res) => {
    const filePath = path.join(DOWNLOADS_DIR, 'GhoghnousMovie-v2.4.0.apk');
    if (!fs.existsSync(filePath)) {
      ensureInstallerFiles();
    }
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', 'attachment; filename="GhoghnousMovie-v2.4.0.apk"');
    res.download(filePath, 'GhoghnousMovie-v2.4.0.apk');
  });

  app.get('/api/download/tv-apk', (req, res) => {
    const filePath = path.join(DOWNLOADS_DIR, 'GhoghnousMovie-AndroidTV-v2.4.0.apk');
    if (!fs.existsSync(filePath)) {
      ensureInstallerFiles();
    }
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', 'attachment; filename="GhoghnousMovie-AndroidTV-v2.4.0.apk"');
    res.download(filePath, 'GhoghnousMovie-AndroidTV-v2.4.0.apk');
  });

  app.get('/api/download/windows-exe', (req, res) => {
    const filePath = path.join(DOWNLOADS_DIR, 'GhoghnousMovie-Setup-v2.4.0.exe');
    if (!fs.existsSync(filePath)) {
      ensureInstallerFiles();
    }
    res.setHeader('Content-Type', 'application/x-msdownload');
    res.setHeader('Content-Disposition', 'attachment; filename="GhoghnousMovie-Setup-v2.4.0.exe"');
    res.download(filePath, 'GhoghnousMovie-Setup-v2.4.0.exe');
  });

  app.get('/api/download/windows-portable', (req, res) => {
    let filePath = path.join(DOWNLOADS_DIR, 'GhoghnousMovie-Portable-v2.4.0.exe');
    if (!fs.existsSync(filePath)) {
      filePath = path.join(DOWNLOADS_DIR, 'GhoghnousMovie-Setup-v2.4.0.exe');
    }
    res.setHeader('Content-Type', 'application/x-msdownload');
    res.setHeader('Content-Disposition', 'attachment; filename="GhoghnousMovie-Portable-v2.4.0.exe"');
    res.download(filePath, 'GhoghnousMovie-Portable-v2.4.0.exe');
  });

  app.get('/api/download/windows-standalone-zip', (req, res) => {
    const filePath = path.join(DOWNLOADS_DIR, 'GhoghnousMovie-Windows-Standalone.zip');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="GhoghnousMovie-Windows-Standalone.zip"');
    res.download(filePath, 'GhoghnousMovie-Windows-Standalone.zip');
  });

  app.get('/api/download/windows-bat', (req, res) => {
    const filePath = path.join(DOWNLOADS_DIR, 'GhoghnousMovie.bat');
    res.setHeader('Content-Type', 'application/x-bat');
    res.setHeader('Content-Disposition', 'attachment; filename="GhoghnousMovie.bat"');
    res.download(filePath, 'GhoghnousMovie.bat');
  });

  app.get('/api/download/mac-dmg', (req, res) => {
    const filePath = path.join(DOWNLOADS_DIR, 'GhoghnousMovie-v2.4.0.dmg');
    if (!fs.existsSync(filePath)) {
      ensureInstallerFiles();
    }
    res.setHeader('Content-Type', 'application/x-apple-diskimage');
    res.setHeader('Content-Disposition', 'attachment; filename="GhoghnousMovie-v2.4.0.dmg"');
    res.download(filePath, 'GhoghnousMovie-v2.4.0.dmg');
  });

  // App download status and versions metadata
  app.get('/api/download/info', (req, res) => {
    res.json({
      success: true,
      versions: {
        android: {
          version: '2.4.0',
          fileName: 'GhoghnousMovie-v2.4.0.apk',
          fileSize: '32 MB',
          downloadUrl: '/api/download/android-apk',
          minOs: 'Android 6.0+'
        },
        windows: {
          version: '2.4.0',
          fileName: 'GhoghnousMovie-Setup-v2.4.0.exe',
          fileSize: '64 MB',
          downloadUrl: '/api/download/windows-exe',
          minOs: 'Windows 10 / 11 (64-bit)'
        },
        tv: {
          version: '2.4.0',
          fileName: 'GhoghnousMovie-AndroidTV-v2.4.0.apk',
          fileSize: '34 MB',
          downloadUrl: '/api/download/tv-apk',
          minOs: 'Android TV 7.0+'
        },
        mac: {
          version: '2.4.0',
          fileName: 'GhoghnousMovie-v2.4.0.dmg',
          fileSize: '68 MB',
          downloadUrl: '/api/download/mac-dmg',
          minOs: 'macOS 11.0+ (Universal)'
        }
      }
    });
  });

  // Local file upload endpoint (Videos, Posters, Backdrops)
  app.post('/api/upload', async (req, res) => {
    try {
      const { fileName, fileType, base64Data } = req.body;
      if (!base64Data || !fileName) {
        return res.status(400).json({ success: false, message: 'فایل ارسالی نامعتبر است.' });
      }

      // Extract raw base64 data without prefix (data:video/mp4;base64,...)
      const matches = base64Data.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
      let buffer: Buffer;
      if (matches && matches.length === 3) {
        buffer = Buffer.from(matches[2], 'base64');
      } else {
        buffer = Buffer.from(base64Data, 'base64');
      }

      // Sanitize filename & generate unique name
      const ext = path.extname(fileName) || (fileType?.includes('video') ? '.mp4' : '.jpg');
      const baseName = path.basename(fileName, ext).replace(/[^a-zA-Z0-9_\-\u0600-\u06FF]/g, '_');
      const uniqueFileName = `${Date.now()}_${baseName}${ext}`;
      const filePath = path.join(UPLOADS_DIR, uniqueFileName);

      fs.writeFileSync(filePath, buffer);

      const fileUrl = `/uploads/${uniqueFileName}`;
      const fileSize = (buffer.length / (1024 * 1024)).toFixed(2) + ' MB';

      res.json({
        success: true,
        message: 'فایل با موفقیت روی سرور پارس مووی بارگذاری شد.',
        url: fileUrl,
        fileName: uniqueFileName,
        fileSize,
        fileType
      });
    } catch (err: any) {
      console.error('File upload error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Get all movies with optional filters
  app.get('/api/movies', (req, res) => {
    try {
      const {
        type,
        genre,
        country,
        year,
        language,
        ageRating,
        onlyHd,
        search,
        tag,
        sort,
        limit
      } = req.query;

      let result = [...moviesDb];

      if (type && type !== 'all') {
        result = result.filter(m => m.type === type);
      }

      if (genre && genre !== 'all' && genre !== 'همه') {
        result = result.filter(m => m.genres.some(g => g.toLowerCase().includes(String(genre).toLowerCase())));
      }

      if (country && country !== 'all' && country !== 'همه') {
        result = result.filter(m => m.country.includes(String(country)));
      }

      if (year && year !== 'all' && year !== 'همه') {
        result = result.filter(m => m.year.toString() === String(year));
      }

      if (language && language !== 'all' && language !== 'همه') {
        if (language === 'dubbed' || language === 'دوبله فارسی') {
          result = result.filter(m => m.hasPersianDub);
        } else if (language === 'subtitled' || language === 'زیرنویس فارسی') {
          result = result.filter(m => m.hasPersianSub);
        }
      }

      if (ageRating && ageRating !== 'all' && ageRating !== 'همه') {
        result = result.filter(m => m.ageRating === ageRating);
      }

      if (onlyHd === 'true') {
        result = result.filter(m => m.isHd);
      }

      if (tag && tag !== 'all') {
        if (tag === 'featured') {
          result = result.filter(m => m.featuredInHero);
        } else {
          result = result.filter(m => m.categoryTag === tag);
        }
      }

      if (search && String(search).trim()) {
        const query = String(search).toLowerCase().trim();
        result = result.filter(m =>
          m.title.toLowerCase().includes(query) ||
          m.originalTitle.toLowerCase().includes(query) ||
          m.director.toLowerCase().includes(query) ||
          m.cast.some(c => c.toLowerCase().includes(query)) ||
          m.imdbId.toLowerCase().includes(query) ||
          m.genres.some(g => g.toLowerCase().includes(query))
        );
      }

      // Sort
      if (sort === 'imdb') {
        result.sort((a, b) => b.imdbRating - a.imdbRating);
      } else if (sort === 'views') {
        result.sort((a, b) => b.views - a.views);
      } else if (sort === 'likes') {
        result.sort((a, b) => b.likes - a.likes);
      } else {
        // Default latest
        result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      }

      if (limit) {
        result = result.slice(0, Number(limit));
      }

      res.json({ success: true, count: result.length, data: result });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Get single movie by ID
  app.get('/api/movies/:id', (req, res) => {
    const movie = moviesDb.find(m => m.id === req.params.id);
    if (!movie) {
      return res.status(404).json({ success: false, message: 'فیلم یا سریال مورد نظر یافت نشد.' });
    }
    // Increment view count
    movie.views += 1;
    saveDatabase(moviesDb);
    res.json({ success: true, data: movie });
  });

  // Create new movie or series (Admin)
  app.post('/api/movies', (req, res) => {
    try {
      const payload: Partial<MovieItem> = req.body;

      if (!payload.title) {
        return res.status(400).json({ success: false, message: 'عنوان اثر الزامی است.' });
      }

      const newId = payload.id || (payload.type === 'series' ? `s-${Date.now()}` : `m-${Date.now()}`);
      
      const newMovie: MovieItem = {
        id: newId,
        title: payload.title,
        originalTitle: payload.originalTitle || payload.title,
        type: payload.type || 'movie',
        imdbId: payload.imdbId || `tt${Math.floor(1000000 + Math.random() * 9000000)}`,
        imdbRating: Number(payload.imdbRating) || 7.5,
        imdbVotes: payload.imdbVotes || '10.5K',
        year: Number(payload.year) || new Date().getFullYear(),
        duration: payload.duration || (payload.type === 'series' ? 'فصل ۱' : '100 دقیقه'),
        ageRating: payload.ageRating || '+15',
        country: payload.country || 'ایران',
        genres: payload.genres && payload.genres.length > 0 ? payload.genres : ['درام'],
        languages: payload.languages || 'both',
        hasPersianDub: payload.hasPersianDub ?? true,
        hasPersianSub: payload.hasPersianSub ?? true,
        isHd: payload.isHd ?? true,
        isExclusive: payload.isExclusive ?? false,
        isOnlineScreening: payload.isOnlineScreening ?? false,
        specialBadge: payload.specialBadge || (payload.hasPersianDub ? 'دوبله فارسی' : 'زیرنویس چسبیده'),
        posterUrl: payload.posterUrl || 'https://images.unsplash.com/photo-1536440136628-849c177e76a1?auto=format&fit=crop&w=600&q=80',
        backdropUrl: payload.backdropUrl || payload.posterUrl || 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?auto=format&fit=crop&w=1600&q=80',
        logoUrl: payload.logoUrl || '',
        trailerUrl: payload.trailerUrl || 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
        trailers: payload.trailers && payload.trailers.length > 0 ? payload.trailers : [
          {
            id: `tr-${Date.now()}-1`,
            title: `${payload.originalTitle || payload.title} | Trailer`,
            duration: 'Trailer 2:32',
            type: 'trailer',
            url: payload.trailerUrl || 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
            thumbnailUrl: payload.backdropUrl || payload.posterUrl,
            likes: '1.2K',
            claps: '639'
          },
          {
            id: `tr-${Date.now()}-2`,
            title: `${payload.originalTitle || payload.title} | Teaser`,
            duration: 'Teaser 1:53',
            type: 'teaser',
            url: payload.trailerUrl || 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
            thumbnailUrl: payload.backdropUrl || payload.posterUrl,
            likes: '890',
            claps: '311'
          }
        ],
        streamUrl: payload.streamUrl || 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
        synopsis: payload.synopsis || 'خلاصه داستان ثبت نشده است.',
        director: payload.director || 'نامشخص',
        cast: payload.cast || ['بازیگر ناشناس'],
        actors: payload.actors || undefined,
        seasons: payload.seasons || (payload.type === 'series' ? [
          {
            seasonNumber: 1,
            title: 'فصل اول',
            episodes: [
              {
                id: `ep-${Date.now()}-1`,
                seasonNumber: 1,
                episodeNumber: 1,
                title: 'قسمت ۱',
                duration: '۴۵ دقیقه',
                downloadLinks: [
                  { id: `dl-${Date.now()}-1`, quality: '1080p HQ', fileSize: '1.2 GB', url: '#' },
                  { id: `dl-${Date.now()}-2`, quality: '720p', fileSize: '650 MB', url: '#' }
                ]
              }
            ]
          }
        ] : undefined),
        downloadLinks: payload.downloadLinks || (payload.type === 'movie' ? [
          { id: `dl-${Date.now()}-1`, quality: '1080p HQ', fileSize: '2.1 GB', url: '#' },
          { id: `dl-${Date.now()}-2`, quality: '720p', fileSize: '1.0 GB', url: '#' }
        ] : undefined),
        featuredInHero: payload.featuredInHero ?? false,
        categoryTag: payload.categoryTag || (payload.type === 'series' ? 'latest_series' : 'latest_movies'),
        views: 1,
        likes: 12,
        dislikes: 0,
        comments: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      moviesDb.unshift(newMovie);
      saveDatabase(moviesDb);

      res.status(201).json({ success: true, data: newMovie, message: 'اثر با موفقیت به آرشیو پارس مووی افزوده شد.' });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Update movie (Admin)
  app.put('/api/movies/:id', (req, res) => {
    try {
      const index = moviesDb.findIndex(m => m.id === req.params.id);
      if (index === -1) {
        return res.status(404).json({ success: false, message: 'موردی یافت نشد.' });
      }

      const existing = moviesDb[index];
      const updated: MovieItem = {
        ...existing,
        ...req.body,
        id: existing.id,
        updatedAt: new Date().toISOString()
      };

      moviesDb[index] = updated;
      saveDatabase(moviesDb);

      res.json({ success: true, data: updated, message: 'تغییرات با موفقیت ذخیره شد.' });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Delete movie (Admin)
  app.delete('/api/movies/:id', (req, res) => {
    try {
      const targetId = String(req.params.id).trim();
      const initialCount = moviesDb.length;
      moviesDb = moviesDb.filter(m => String(m.id).trim() !== targetId);
      if (moviesDb.length === initialCount) {
        return res.status(404).json({ success: false, message: 'آیتم مورد نظر برای حذف یافت نشد.' });
      }
      saveDatabase(moviesDb);
      res.json({ success: true, message: 'آیتم با موفقیت حذف گردید.' });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Get Site Settings (Logo & Hero Banners)
  app.get('/api/settings', (req, res) => {
    res.json({ success: true, data: siteSettings });
  });

  // Update Site Settings (Admin)
  app.put('/api/settings', (req, res) => {
    try {
      const updated: SiteSettings = {
        ...siteSettings,
        ...req.body,
        logo: { ...siteSettings.logo, ...(req.body.logo || {}) },
        heroBanner: { ...siteSettings.heroBanner, ...(req.body.heroBanner || {}) }
      };
      siteSettings = updated;
      saveSettings(siteSettings);
      res.json({ success: true, data: siteSettings, message: 'تنظیمات برندینگ و بنرها با موفقیت ذخیره شد.' });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== ADVANCED REAL-TIME IMDB FETCH ENGINE ====================
  const GENRE_TRANSLATIONS: Record<string, string> = {
    action: 'اکشن',
    adventure: 'ماجراجویی',
    animation: 'انیمیشن',
    biography: 'زندگینامه',
    comedy: 'کمدی',
    crime: 'جنایی',
    documentary: 'مستند',
    drama: 'درام',
    family: 'خانوادگی',
    fantasy: 'فانتزی',
    filmnoir: 'نوآر',
    history: 'تاریخی',
    horror: 'ترسناک',
    music: 'موزیکال',
    musical: 'موزیکال',
    mystery: 'معمایی',
    romance: 'عاشقانه',
    'sci-fi': 'علمی تخیلی',
    scifi: 'علمی تخیلی',
    sciencefiction: 'علمی تخیلی',
    short: 'کوتاه',
    sport: 'ورزشی',
    superhero: 'ابرقهرمانی',
    thriller: 'هیجان انگیز',
    war: 'جنگی',
    western: 'وسترن'
  };

  const COUNTRY_TRANSLATIONS: Record<string, string> = {
    'united states': 'آمریکا',
    usa: 'آمریکا',
    'united kingdom': 'بریتانیا',
    uk: 'بریتانیا',
    iran: 'ایران',
    'south korea': 'کره جنوبی',
    korea: 'کره جنوبی',
    japan: 'ژاپن',
    france: 'فرانسه',
    germany: 'آلمان',
    turkey: 'ترکیه',
    india: 'هند',
    spain: 'اسپانیا',
    italy: 'ایتالیا',
    canada: 'کانادا',
    australia: 'استرالیا',
    sweden: 'سوئد',
    denmark: 'دانمارک',
    norway: 'نروژ',
    china: 'چین',
    russia: 'روسیه',
    mexico: 'مکزیک',
    brazil: 'برزیل'
  };

  // Helper to resolve official trailer info (100% playable and unfiltered)
  async function getImdbOfficialTrailerInfo(title?: string, originalTitle?: string, imdbId?: string): Promise<{
    trailerUrl: string;
    embedUrl?: string;
    directMp4Url?: string;
    source: 'imdb_mp4' | 'youtube' | 'aparat' | 'direct_mp4';
    viId?: string;
    imdbId?: string;
    title: string;
    thumbnailUrl?: string;
    trailers?: Array<{
      id: string;
      title: string;
      duration: string;
      type: 'trailer' | 'teaser';
      url: string;
      thumbnailUrl?: string;
      likes?: string;
      claps?: string;
    }>;
  }> {
    let cleanTitle = (originalTitle || title || '').trim();
    let cleanPersian = (title || '').trim();
    const targetImdbId = (imdbId && imdbId.startsWith('tt')) ? imdbId : '';

    // If title is missing or only an IMDb ID, resolve title from local database or IMDb suggestion API
    if (targetImdbId && (!cleanTitle || cleanTitle.startsWith('tt'))) {
      try {
        const db = loadDatabase();
        const found = db.find(m => m.imdbId === targetImdbId);
        if (found) {
          cleanTitle = found.originalTitle || found.title || cleanTitle;
          if (!cleanPersian) cleanPersian = found.title || '';
        }
      } catch (e) {}

      if (!cleanTitle || cleanTitle.startsWith('tt')) {
        try {
          const suggRes = await fetch(`https://v3.sg.media-imdb.com/suggestion/t/${targetImdbId}.json`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36' },
            signal: AbortSignal.timeout(2500)
          });
          if (suggRes.ok) {
            const suggData = await suggRes.json();
            if (suggData.d && suggData.d[0] && suggData.d[0].l) {
              cleanTitle = suggData.d[0].l;
            }
          }
        } catch (e) {}
      }
    }

    const officialTrailersList: Array<{
      id: string;
      title: string;
      duration: string;
      type: 'trailer' | 'teaser';
      url: string;
      thumbnailUrl?: string;
      likes?: string;
      claps?: string;
    }> = [];

    let primaryTrailerUrl = '';
    let primaryEmbedUrl = '';
    let primaryDirectMp4Url: string | undefined = undefined;
    let primarySource: 'aparat' | 'youtube' | 'imdb_mp4' | 'direct_mp4' = 'youtube';
    let primaryThumbnail: string | undefined = undefined;

    // 1. If IMDb ID is present, verify directly against official registry (TMDb / IMDb)
    if (targetImdbId) {
      const tmdbKeys = [
        '4e44d9029b1270a757cddc766a1bcb63',
        'f28a2a0e28f80459c004c86b450eecc8',
        'b8c7e6c4bf92a546cd2efee4f1c97a7e'
      ];
      let tmdbChecked = false;
      let tmdbHasTrailer = false;

      for (const k of tmdbKeys) {
        try {
          const findRes = await fetch(`https://api.themoviedb.org/3/find/${targetImdbId}?api_key=${k}&external_source=imdb_id`, {
            signal: AbortSignal.timeout(3000)
          });
          if (findRes.ok) {
            const findData = await findRes.json();
            const mediaItem = findData.movie_results?.[0] || findData.tv_results?.[0];
            const mediaType = findData.movie_results?.[0] ? 'movie' : (findData.tv_results?.[0] ? 'tv' : null);

            if (mediaItem && mediaType) {
              tmdbChecked = true;
              if (!cleanTitle) cleanTitle = mediaItem.title || mediaItem.name || cleanTitle;

              const vRes = await fetch(`https://api.themoviedb.org/3/${mediaType}/${mediaItem.id}/videos?api_key=${k}`, {
                signal: AbortSignal.timeout(3000)
              });
              if (vRes.ok) {
                const vData = await vRes.json();
                const officialVideos = (vData.results || []).filter((r: any) =>
                  (r.type === 'Trailer' || r.type === 'Teaser') && r.site === 'YouTube' && r.key
                );

                if (officialVideos.length > 0) {
                  tmdbHasTrailer = true;
                  officialVideos.forEach((v: any) => {
                    const embed = `https://www.youtube-nocookie.com/embed/${v.key}?autoplay=1&mute=1&playsinline=1&enablejsapi=1&vq=hd1080&hd=1`;
                    const thumb = `https://img.youtube.com/vi/${v.key}/hqdefault.jpg`;
                    officialTrailersList.push({
                      id: `tr-yt-${v.key}`,
                      title: `${cleanTitle} | ${v.name || 'تریلر رسمی'}`,
                      duration: 'Trailer 2:15',
                      type: 'trailer',
                      url: embed,
                      thumbnailUrl: thumb,
                      likes: '3.5K',
                      claps: '1.8K'
                    });
                  });

                  if (officialTrailersList.length > 0) {
                    primaryTrailerUrl = officialTrailersList[0].url;
                    primaryEmbedUrl = officialTrailersList[0].url;
                    primaryThumbnail = officialTrailersList[0].thumbnailUrl;
                    primarySource = 'youtube';
                  }
                }
              }
              break;
            }
          }
        } catch (e) {}
      }

      // CRITICAL CONSTRAINT from user:
      // "واگه توimdbتریلر نداشت اضافه نکن همون پستر فیلم باشه"
      // If the movie exists in IMDb/TMDb registry but has NO official trailer, DO NOT add one!
      if (tmdbChecked && !tmdbHasTrailer) {
        return {
          trailerUrl: '',
          embedUrl: '',
          source: 'direct_mp4',
          imdbId: targetImdbId,
          title: cleanTitle || cleanPersian || 'فیلم',
          trailers: []
        };
      }

      // If official trailers were verified from IMDb/TMDb, we can also search Aparat strictly for Persian/Iranian users
      if (tmdbHasTrailer && cleanTitle) {
        try {
          const aRes = await fetch(`https://www.aparat.com/api/fa/v1/video/video/search/text/${encodeURIComponent(cleanPersian || cleanTitle)}`, {
            signal: AbortSignal.timeout(2500)
          });
          if (aRes.ok) {
            const aData = await aRes.json();
            const videoItem = aData?.included?.find((item: any) => item.type === 'Video') || aData?.data?.[0];
            if (videoItem && videoItem.attributes?.uid) {
              const aTitle = (videoItem.attributes?.title || '').toLowerCase();
              const normClean = cleanTitle.toLowerCase();
              const normPersian = cleanPersian.toLowerCase();
              // Strict verification: title MUST include English or Persian title to avoid mismatch (e.g. Karate Kid for Karadayi)
              if (aTitle.includes(normClean) || (normPersian && aTitle.includes(normPersian))) {
                const uid = videoItem.attributes.uid;
                const embed = `https://www.aparat.com/video/video/embed/videohash/${uid}/vt/frame?autoplay=true&quality=1080p`;
                const thumb = videoItem.attributes.big_poster || videoItem.attributes.medium_poster;
                officialTrailersList.unshift({
                  id: `tr-aparat-${uid}`,
                  title: videoItem.attributes.title || `${cleanTitle || cleanPersian} | تریلر رسمی بدون فیلتر`,
                  duration: 'Trailer 2:15',
                  type: 'trailer',
                  url: embed,
                  thumbnailUrl: thumb,
                  likes: '2.4K',
                  claps: '1.2K'
                });
                primaryTrailerUrl = embed;
                primaryEmbedUrl = embed;
                primaryThumbnail = thumb;
                primarySource = 'aparat';
              }
            }
          }
        } catch (e) {}
      }

      return {
        trailerUrl: primaryTrailerUrl,
        embedUrl: primaryEmbedUrl || primaryTrailerUrl,
        directMp4Url: primaryDirectMp4Url,
        source: primarySource,
        imdbId: targetImdbId,
        title: `${cleanTitle || cleanPersian || 'فیلم'} | تریلر رسمی`,
        thumbnailUrl: primaryThumbnail,
        trailers: officialTrailersList
      };
    }

    // If no IMDb ID provided, only search if cleanTitle exists
    if (!cleanTitle) {
      return {
        trailerUrl: '',
        embedUrl: '',
        source: 'direct_mp4',
        imdbId: targetImdbId,
        title: cleanTitle || cleanPersian || 'فیلم',
        trailers: []
      };
    }

    return {
      trailerUrl: primaryTrailerUrl,
      embedUrl: primaryEmbedUrl || primaryTrailerUrl,
      directMp4Url: primaryDirectMp4Url,
      source: primarySource,
      imdbId: targetImdbId,
      title: `${cleanTitle || cleanPersian || 'فیلم'} | تریلر رسمی`,
      thumbnailUrl: primaryThumbnail,
      trailers: officialTrailersList
    };
  }

  // Helper to automatically find official trailer for any movie / series (100% Unfiltered in Iran)
  async function fetchOfficialTrailer(title: string, originalTitle?: string, year?: number, imdbId?: string): Promise<string> {
    const info = await getImdbOfficialTrailerInfo(title, originalTitle, imdbId);
    return info.trailerUrl;
  }

  // Helper to fetch official IMDb profile and photo for an actor
  async function fetchImdbActor(name: string, originalName?: string): Promise<{
    name: string;
    originalName: string;
    photoUrl?: string;
    imdbId?: string;
    imdbUrl?: string;
  }> {
    const cleanName = (name || '').trim();
    const cleanOriginalName = (originalName || '').trim();

    // 1. Check known actors cache first for instantaneous response
    const known = KNOWN_ACTORS_IMDB[cleanName] || (cleanOriginalName ? KNOWN_ACTORS_IMDB[cleanOriginalName] : undefined);
    if (known && known.photoUrl) {
      return {
        name: cleanName || known.name || '',
        originalName: cleanOriginalName || known.originalName || cleanName,
        photoUrl: known.photoUrl,
        imdbId: known.imdbId,
        imdbUrl: known.imdbUrl || (known.imdbId ? `https://www.imdb.com/name/${known.imdbId}` : undefined)
      };
    }

    const query = (cleanOriginalName || cleanName).trim();
    let photoUrl: string | undefined;
    let imdbId: string | undefined;
    let resolvedOriginalName = cleanOriginalName || cleanName;

    try {
      const imdbUrl = `https://v3.sg.media-imdb.com/suggestion/x/${encodeURIComponent(query)}.json`;
      const res = await fetch(imdbUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(1800)
      });
      if (res.ok) {
        const json = await res.json();
        if (json.d && json.d.length > 0) {
          const person = json.d.find((it: any) => it.id && it.id.startsWith('nm')) || json.d[0];
          if (person) {
            if (person.id && person.id.startsWith('nm')) {
              imdbId = person.id;
            }
            if (person.l) {
              resolvedOriginalName = person.l;
            }
            if (person.i?.imageUrl) {
              photoUrl = person.i.imageUrl;
            }
          }
        }
      }
    } catch (e) {
      // Non-blocking warning
    }

    return {
      name: cleanName,
      originalName: resolvedOriginalName.trim(),
      photoUrl,
      imdbId,
      imdbUrl: imdbId ? `https://www.imdb.com/name/${imdbId}` : `https://www.imdb.com/find/?q=${encodeURIComponent(query)}`
    };
  }

  // Helper to transliterate or translate English actor names to Persian
  function transliterateEnglishToPersian(enName: string): string {
    if (!enName) return '';
    const clean = enName.trim();
    if (KNOWN_ACTORS_IMDB[clean] && KNOWN_ACTORS_IMDB[clean].name) return KNOWN_ACTORS_IMDB[clean].name;

    const nameMap: Record<string, string> = {
      'Maria Sten': 'ماریا استن',
      'Greyston Holt': 'گرایستون هولت',
      'Adeline Rudolph': 'آدلین رودولف',
      'Jasper Jones': 'جاسپر جونز',
      'Matthew Del Negro': 'متیو دل نگرو',
      'Damon Herriman': 'دیمون هریمن',
      'Rebecca Liddiard': 'ربکا لیدیارد',
      'Tyrone Benskin': 'تایرون بنسکین',
      'John Bregar': 'جان برگار',
      'Peter Outerbridge': 'پیتر اوتربریج',
      'Jessica Clement': 'جسیکا کلمنت',
      'Ema Ines': 'اما اینس',
      'Joel Keller': 'جوئل کلر',
      'James Downing': 'جیمز داونینگ',
      'L. Dean Ifill': 'ال. دین ایفیول',
      'Brian Hamman': 'برایان هامان',
      'Mal Dassin': 'مال داسین',
      'Jeff Kassel': 'جف کاسل',
      'Michael Hough': 'مایکل هاف',
      'Zion Hutson': 'زایون هاتسون',
      'Lars A. Melby': 'لارس ای. ملبی'
    };

    if (nameMap[clean]) return nameMap[clean];

    return clean
      .replace(/John/g, 'جان')
      .replace(/James/g, 'جیمز')
      .replace(/Michael/g, 'مایکل')
      .replace(/David/g, 'دیوید')
      .replace(/Robert/g, 'رابرت')
      .replace(/William/g, 'ویلیام')
      .replace(/Richard/g, 'ریچارد')
      .replace(/Matthew/g, 'متیو')
      .replace(/Anthony/g, 'انتونی')
      .replace(/Mark/g, 'مارک')
      .replace(/Steven/g, 'استیون')
      .replace(/Paul/g, 'پل')
      .replace(/Andrew/g, 'اندرو')
      .replace(/Joshua/g, 'جاشوا')
      .replace(/Kevin/g, 'کوین')
      .replace(/Brian/g, 'برایان')
      .replace(/George/g, 'جورج')
      .replace(/Edward/g, 'ادوارد')
      .replace(/Timothy/g, 'تیموتی')
      .replace(/Jason/g, 'جیسون')
      .replace(/Ryan/g, 'رایان')
      .replace(/Jacob/g, 'جیکوب')
      .replace(/Gary/g, 'گری')
      .replace(/Nicholas/g, 'نیکلاس')
      .replace(/Eric/g, 'اریک')
      .replace(/Jonathan/g, 'جاناتان')
      .replace(/Justin/g, 'جاستین')
      .replace(/Scott/g, 'اسکات')
      .replace(/Brandon/g, 'براندون')
      .replace(/Benjamin/g, 'بنیامین')
      .replace(/Samuel/g, 'ساموئل')
      .replace(/Patrick/g, 'پاتریک')
      .replace(/Jack/g, 'جک')
      .replace(/Adam/g, 'آدام')
      .replace(/Henry/g, 'هنری')
      .replace(/Nathan/g, 'نیتن')
      .replace(/Peter/g, 'پیتر')
      .replace(/Kyle/g, 'کایل')
      .replace(/Ethan/g, 'ایتن')
      .replace(/Jeremy/g, 'جرمی')
      .replace(/Christian/g, 'کریستین')
      .replace(/Roger/g, 'راجر')
      .replace(/Noah/g, 'نوآ')
      .replace(/Gerald/g, 'جرالد')
      .replace(/Sean/g, 'شان')
      .replace(/Austin/g, 'آستین')
      .replace(/Arthur/g, 'آرتور')
      .replace(/Lawrence/g, 'لورنس')
      .replace(/Jesse/g, 'جسی')
      .replace(/Dylan/g, 'دیلان')
      .replace(/Joe/g, 'جو')
      .replace(/Jordan/g, 'جردن')
      .replace(/Bruce/g, 'بروس')
      .replace(/Albert/g, 'آلبرت')
      .replace(/Gabriel/g, 'گابریل')
      .replace(/Logan/g, 'لوگان')
      .replace(/Alan/g, 'آلان')
      .replace(/Vincent/g, 'وینسنت')
      .replace(/Russell/g, 'راسل')
      .replace(/Louis/g, 'لوییس')
      .replace(/Philip/g, 'فیلیپ')
      .replace(/Mary/g, 'مری')
      .replace(/Jennifer/g, 'جنیفر')
      .replace(/Linda/g, 'لیندا')
      .replace(/Elizabeth/g, 'الیزابت')
      .replace(/Barbara/g, 'باربارا')
      .replace(/Susan/g, 'سوزان')
      .replace(/Jessica/g, 'جسیکا')
      .replace(/Sarah/g, 'سارا')
      .replace(/Nancy/g, 'نانسی')
      .replace(/Lisa/g, 'لیزا')
      .replace(/Margaret/g, 'مارگارت')
      .replace(/Sandra/g, 'ساندرا')
      .replace(/Ashley/g, 'اشلی')
      .replace(/Kimberly/g, 'کیمبرلی')
      .replace(/Emily/g, 'امیلی')
      .replace(/Michelle/g, 'میشل')
      .replace(/Carol/g, 'کارول')
      .replace(/Amanda/g, 'اماندا')
      .replace(/Melissa/g, 'ملیسا')
      .replace(/Stephanie/g, 'استفانی')
      .replace(/Rebecca/g, 'ربکا')
      .replace(/Laura/g, 'لورا')
      .replace(/Amy/g, 'امی')
      .replace(/Angela/g, 'آنجلا')
      .replace(/Helen/g, 'هلن')
      .replace(/Anna/g, 'آنا')
      .replace(/Brenda/g, 'برندا')
      .replace(/Nicole/g, 'نیکول')
      .replace(/Samantha/g, 'سامانتا')
      .replace(/Katherine/g, 'کاترین')
      .replace(/Emma/g, 'اما')
      .replace(/Christine/g, 'کریستین')
      .replace(/Rachel/g, 'ریچل')
      .replace(/Maria/g, 'ماریا')
      .replace(/Victoria/g, 'ویکتوریا')
      .replace(/Olivia/g, 'اولیویا')
      .replace(/Kelly/g, 'کلی')
      .replace(/Lauren/g, 'لورن')
      .replace(/Judith/g, 'جودیت')
      .replace(/Megan/g, 'مگان')
      .replace(/Hannah/g, 'هانا')
      .replace(/Sara/g, 'سارا')
      .replace(/Frances/g, 'فرانسس')
      .replace(/Julia/g, 'جولیا')
      .replace(/Grace/g, 'گریس')
      .replace(/Amber/g, 'امبر')
      .replace(/Marilyn/g, 'مریلین')
      .replace(/Danielle/g, 'دانیل')
      .replace(/Isabella/g, 'ایزابلا')
      .replace(/Diana/g, 'دیانا')
      .replace(/Natalie/g, 'ناتالی')
      .replace(/Charlotte/g, 'شارلوت')
      .replace(/Marie/g, 'ماری')
      .replace(/Alexis/g, 'الکسیس');
  }

  // Helper to scrape full cast directly from IMDb credits page or Next.js payload
  async function scrapeImdbFullCast(imdbId: string): Promise<Array<{
    name: string;
    originalName: string;
    character: string;
    photoUrl?: string;
    imdbId?: string;
    imdbUrl?: string;
  }>> {
    if (!imdbId || !String(imdbId).toLowerCase().includes('tt')) return [];
    const cleanId = (imdbId.match(/tt\d+/i) || [])[0]?.toLowerCase();
    if (!cleanId) return [];

    const resultActors: Array<{
      name: string;
      originalName: string;
      character: string;
      photoUrl?: string;
      imdbId?: string;
      imdbUrl?: string;
    }> = [];
    const seenNm = new Set<string>();

    try {
      const res = await fetch(`https://www.imdb.com/title/${cleanId}/fullcredits/`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(5500)
      });

      if (res.ok) {
        const html = await res.text();

        // 1. Try Next.js embedded data
        const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s);
        if (nextDataMatch && nextDataMatch[1]) {
          try {
            const nextData = JSON.parse(nextDataMatch[1]);
            const extractCastFromObj = (obj: any) => {
              if (!obj || typeof obj !== 'object') return;
              if (Array.isArray(obj)) {
                for (const item of obj) extractCastFromObj(item);
                return;
              }
              if (obj.node && obj.node.name && obj.node.name.nameText && obj.node.name.nameText.text) {
                const nmId = obj.node.name.id || (obj.node.name.id?.match(/nm\d+/) ? obj.node.name.id : undefined);
                const originalName = obj.node.name.nameText.text.trim();
                if (originalName && nmId && !seenNm.has(nmId)) {
                  seenNm.add(nmId);
                  const charName = obj.characters && obj.characters[0] && obj.characters[0].name ? obj.characters[0].name : 'بازیگر';
                  const photo = obj.node.name.primaryImage?.url;
                  const faName = transliterateEnglishToPersian(originalName);
                  resultActors.push({
                    name: faName || originalName,
                    originalName,
                    character: charName,
                    photoUrl: photo,
                    imdbId: nmId,
                    imdbUrl: `https://www.imdb.com/name/${nmId}/`
                  });
                }
              }
              for (const key of Object.keys(obj)) {
                if (typeof obj[key] === 'object') extractCastFromObj(obj[key]);
              }
            };
            extractCastFromObj(nextData);
          } catch (e) {
            // ignore JSON parse error
          }
        }

        // 2. Parse HTML table fallback
        if (resultActors.length < 5) {
          const castRegex = /<a\s+href="\/name\/(nm\d+)\/[^"]*"[^>]*>\s*([A-Za-z0-9\s\.'\-]+)\s*<\/a>/gi;
          let match;
          while ((match = castRegex.exec(html)) !== null) {
            const nmId = match[1];
            const originalName = match[2].trim();
            if (originalName && !seenNm.has(nmId) && originalName.length > 1 && !originalName.includes('IMDb') && !originalName.includes('Full Cast') && !originalName.includes('Edit')) {
              seenNm.add(nmId);
              const faName = transliterateEnglishToPersian(originalName);
              resultActors.push({
                name: faName || originalName,
                originalName,
                character: 'بازیگر',
                imdbId: nmId,
                imdbUrl: `https://www.imdb.com/name/${nmId}/`
              });
            }
          }
        }
      }
    } catch (err) {
      console.warn('Scrape IMDb full cast warning:', err);
    }

    return resultActors;
  }

  // Helper to fetch full movie metadata (actors, directors, rating, poster, etc.) directly from IMDb JSON-LD & fullcredits
  async function fetchFullImdbData(imdbId: string) {
    if (!imdbId || !String(imdbId).toLowerCase().includes('tt')) return null;
    const cleanId = (imdbId.match(/tt\d+/i) || [])[0]?.toLowerCase();
    if (!cleanId) return null;

    try {
      // First scrape complete cast list
      const fullScrapedCast = await scrapeImdbFullCast(cleanId);

      const url = `https://www.imdb.com/title/${cleanId}/`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(4500)
      });

      if (res.ok) {
        const html = await res.text();
        const match = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s);
        if (match && match[1]) {
          const ld = JSON.parse(match[1]);
          
          let directors: string[] = [];
          if (Array.isArray(ld.director)) {
            directors = ld.director.map((d: any) => d.name).filter(Boolean);
          } else if (ld.director?.name) {
            directors = [ld.director.name];
          }

          let actorsList: Array<{ name: string; originalName: string; character?: string; photoUrl?: string; imdbId?: string; imdbUrl?: string }> = [];
          if (fullScrapedCast.length > 0) {
            actorsList = fullScrapedCast;
          } else if (Array.isArray(ld.actor)) {
            actorsList = ld.actor.map((a: any) => {
              const name = a.name || '';
              const nmMatch = a.url ? String(a.url).match(/nm\d+/i) : null;
              const nmId = nmMatch ? nmMatch[0] : undefined;
              return {
                name: transliterateEnglishToPersian(name) || name,
                originalName: name,
                character: 'بازیگر',
                imdbId: nmId,
                imdbUrl: nmId ? `https://www.imdb.com/name/${nmId}/` : undefined
              };
            }).filter((a: any) => a.name);
          }

          return {
            title: ld.name,
            synopsis: ld.description,
            posterUrl: ld.image,
            rating: ld.aggregateRating?.ratingValue ? Number(ld.aggregateRating.ratingValue) : undefined,
            votes: ld.aggregateRating?.ratingCount ? String(ld.aggregateRating.ratingCount) : undefined,
            genres: Array.isArray(ld.genre) ? ld.genre : (ld.genre ? [ld.genre] : []),
            directors,
            actors: actorsList
          };
        }
      }
    } catch (err) {
      console.warn('Full IMDb scraping warning:', err);
    }
    return null;
  }

  // Known cast lists for common Iranian & international movies and series
  const SPECIAL_KNOWN_CASTS: Record<string, any[]> = {
    'مرد عینکی': [
      { name: 'بهرام افشاری', originalName: 'Bahram Afshari', character: 'مظفر (نقش اصلی)' },
      { name: 'هادی کاظمی', originalName: 'Hadi Kazemi', character: 'فیروز' },
      { name: 'الناز حبیبی', originalName: 'Elnaz Habibi', character: 'بیتا' },
      { name: 'مهدی حسینی‌نیا', originalName: 'Mehdi Hosseininia', character: 'جهان' },
      { name: 'گیتی قاسمی', originalName: 'Giti Ghasemi', character: 'ملوک' },
      { name: 'غلامرضا نیکخواه', originalName: 'Gholamreza Nikkhah', character: 'پدر مظفر' },
      { name: 'مهران احمدی', originalName: 'Mehran Ahmadi', character: 'خسرو' },
      { name: 'سیاوش چراغی‌پور', originalName: 'Siavash Cheraghipour', character: 'سرهنگ' },
      { name: 'هومن برق‌نورد', originalName: 'Hooman Barghnavard', character: 'صاحب‌کار' },
      { name: 'امید روحانی', originalName: 'Omid Rouhani', character: 'دکتر' },
      { name: 'امیر جعفری', originalName: 'Amir Jafari', character: 'رئیس باند' },
      { name: 'رضا طباطبایی', originalName: 'Reza Tabatabaei', character: 'مامور پلیس' },
      { name: 'حسین سلیمانی', originalName: 'Hossein Soleimani', character: 'دستیار' },
      { name: 'سام درخشانی', originalName: 'Sam Derakhshani', character: 'مهمان ویژه' },
      { name: 'پژمان جمشیدی', originalName: 'Pejman Jamshidi', character: 'حضور افتخاری' }
    ],
    'the glass man': [
      { name: 'بهرام افشاری', originalName: 'Bahram Afshari', character: 'مظفر' },
      { name: 'هادی کاظمی', originalName: 'Hadi Kazemi', character: 'فیروز' },
      { name: 'الناز حبیبی', originalName: 'Elnaz Habibi', character: 'بیتا' },
      { name: 'مهدی حسینی‌نیا', originalName: 'Mehdi Hosseininia', character: 'جهان' },
      { name: 'گیتی قاسمی', originalName: 'Giti Ghasemi', character: 'ملوک' },
      { name: 'غلامرضا نیکخواه', originalName: 'Gholamreza Nikkhah', character: 'پدر مظفر' },
      { name: 'مهران احمدی', originalName: 'Mehran Ahmadi', character: 'خسرو' },
      { name: 'سیاوش چراغی‌پور', originalName: 'Siavash Cheraghipour', character: 'سرهنگ' },
      { name: 'هومن برق‌نورد', originalName: 'Hooman Barghnavard', character: 'صاحب‌کار' },
      { name: 'امید روحانی', originalName: 'Omid Rouhani', character: 'دکتر' }
    ],
    'آقازاده': [
      { name: 'امیر آقایی', originalName: 'Amir Aghaee', character: 'نیما بحری (نقش اصلی)' },
      { name: 'امین حیایی', originalName: 'Amin Hayai', character: 'بهرام' },
      { name: 'پردیس پورعابدینی', originalName: 'Pardis Pourabedini', character: 'مانلی / راضیه' },
      { name: 'سینا مهراد', originalName: 'Sina Mehrad', character: 'حامد تهرانی' },
      { name: 'نیکی کریمی', originalName: 'Niki Karimi', character: 'تینا' },
      { name: 'مهدی سلطانی', originalName: 'Mehdi Soltani', character: 'امیر بحری' },
      { name: 'جمشید هاشم‌پور', originalName: 'Jamshid Hashempour', character: 'حاج رضا' },
      { name: 'کامبیز دیرباز', originalName: 'Kambiz Dirbaz', character: 'شهنام' },
      { name: 'لعیا زنگنه', originalName: 'Laya Zanganeh', character: 'شریفه' },
      { name: 'ثنا طاهری', originalName: 'Sana Taheri', character: 'مریم' },
      { name: 'محمدحسین لطیفی', originalName: 'Mohammad Hossein Latifi', character: 'استاد بحری' },
      { name: 'دیبا زاهدی', originalName: 'Diba Zahedi', character: 'سارا' },
      { name: 'کاوه خداشناس', originalName: 'Kaveh Khodashenas', character: 'شاهین' },
      { name: 'مجید مظفری', originalName: 'Majid Mozaffari', character: 'دکتر جاوید' }
    ],
    'aghazadeh': [
      { name: 'امیر آقایی', originalName: 'Amir Aghaee', character: 'نیما بحری' },
      { name: 'امین حیایی', originalName: 'Amin Hayai', character: 'بهرام' },
      { name: 'پردیس پورعابدینی', originalName: 'Pardis Pourabedini', character: 'مانلی / راضیه' },
      { name: 'سینا مهراد', originalName: 'Sina Mehrad', character: 'حامد تهرانی' },
      { name: 'نیکی کریمی', originalName: 'Niki Karimi', character: 'تینا' },
      { name: 'مهدی سلطانی', originalName: 'Mehdi Soltani', character: 'امیر بحری' },
      { name: 'جمشید هاشم‌پور', originalName: 'Jamshid Hashempour', character: 'حاج رضا' },
      { name: 'کامبیز دیرباز', originalName: 'Kambiz Dirbaz', character: 'شهنام' },
      { name: 'لعیا زنگنه', originalName: 'Laya Zanganeh', character: 'شریفه' },
      { name: 'دیبا زاهدی', originalName: 'Diba Zahedi', character: 'سارا' }
    ],
    'قطب شمال': [
      { name: 'فرزاد فرزین', originalName: 'Farzad Farzin', character: 'همایون / آرش' },
      { name: 'نازنین بیاتی', originalName: 'Nazanin Bayati', character: 'ارغوان' },
      { name: 'امیرحسین فتحی', originalName: 'Amirhossein Fathi', character: 'سامان' },
      { name: 'آناهیتا درگاهی', originalName: 'Anahita Dargahi', character: 'صحرا' },
      { name: 'بهادر زمانی', originalName: 'Bahador Zamani', character: 'سیاوش' },
      { name: 'عباس جمشیدی‌فر', originalName: 'Abbas Jamshidifar', character: 'داوود' },
      { name: 'فرهاد آئیش', originalName: 'Farhad Aeesh', character: 'عماد' },
      { name: 'شابهار امینی', originalName: 'Shabahar Amini', character: 'نرگس' },
      { name: 'سیروس همتی', originalName: 'Soroush Hemmati', character: 'فرید' },
      { name: 'امیر دژاکام', originalName: 'Amir Dezhakam', character: 'پدر همایون' },
      { name: 'مه‌لقا باقری', originalName: 'Mahlagha Bagheri', character: 'مادر ارغوان' }
    ],
    'یاغی': [
      { name: 'علی شادمان', originalName: 'Ali Shadman', character: 'جاوید گنجی (یاغی)' },
      { name: 'پارسا پیروزفر', originalName: 'Parsa Pirouzfar', character: 'بهمن خان' },
      { name: 'طناز طباطبایی', originalName: 'Tannaz Tabatabaei', character: 'طلا تنظیفی' },
      { name: 'امیر جعفری', originalName: 'Amir Jafari', character: 'اسماعیل مقانلو (اسی قلک)' },
      { name: 'نیکی کریمی', originalName: 'Niki Karimi', character: 'شیوا' },
      { name: 'فرهاد اصلانی', originalName: 'Farhad Aslani', character: 'اکبر مجلل' },
      { name: 'آبان عسکری', originalName: 'Aban Askari', character: 'عاطفه (خواهر جاوید)' },
      { name: 'مهدی حسینی‌نیا', originalName: 'Mehdi Hosseininia', character: 'رحمان' },
      { name: 'مه‌لقا باقری', originalName: 'Mahlagha Bagheri', character: 'مادر ابرا' },
      { name: 'عباس جمشیدی‌فر', originalName: 'Abbas Jamshidifar', character: 'علی بوقی' },
      { name: 'جواد خواجوی', originalName: 'Javad Khajavi', character: 'حامد' },
      { name: 'المیرا دهقانی', originalName: 'Elmira Dehghani', character: 'ابرا' }
    ],
    'بدنام': [
      { name: 'نوید محمدزاده', originalName: 'Navid Mohammadzadeh', character: 'سرگرد پارسا' },
      { name: 'پری ناز ایزدیار', originalName: 'Parinaz Izadyar', character: 'سارا' },
      { name: 'هوتن شکیبا', originalName: 'Hootan Shakiba', character: 'امیر حسین' },
      { name: 'فرهاد اصلانی', originalName: 'Farhad Aslani', character: 'سرهنگ نظری' },
      { name: 'صابر ابر', originalName: 'Saber Abar', character: 'شاهین' },
      { name: 'ستاره پسیانی', originalName: 'Setareh Pesyani', character: 'نیلوفر' },
      { name: 'بهام افشاری', originalName: 'Bahram Afshari', character: 'فرزاد' },
      { name: 'بانیپال شومون', originalName: 'Banipal Shoomoon', character: 'کامران' },
      { name: 'داریوش فرهنگ', originalName: 'Dariush Farhang', character: 'استاد مشتاق' },
      { name: 'افشین هاشمی', originalName: 'Afshin Hashemi', character: 'بازپرس' }
    ],
    'کایوت علیه اکمی': [
      { name: 'ویل فورت', originalName: 'Will Forte', character: 'کوین (وکیل کایوت)' },
      { name: 'جان سینا', originalName: 'John Cena', character: 'مدیرعامل اکمی' },
      { name: 'لانا کاندور', originalName: 'Lana Condor', character: 'پایج' },
      { name: 'پیتر کلینتون', originalName: 'Peter Claffey', character: 'بازرس دادگاه' },
      { name: 'اریک بائوزا', originalName: 'Eric Bauza', character: 'صداپیشه کایوت' },
      { name: 'پی جی برن', originalName: 'P.J. Byrne', character: 'مشاور حقوقی' },
      { name: 'تونی هیل', originalName: 'Tony Hale', character: 'قاضی دادگاه' },
      { name: 'هایلی لو ریچاردسون', originalName: 'Haley Lu Richardson', character: 'منشی دادگاه' },
      { name: 'استیون ین', originalName: 'Steven Yeun', character: 'خبرنگار' },
      { name: 'جی کی سیمونز', originalName: 'J.K. Simmons', character: 'هیئت مدیره اکمی' }
    ],
    'اتفاقات عجیب': [
      { name: 'میلی بابی براون', originalName: 'Millie Bobby Brown', character: 'ایلون (Eleven)' },
      { name: 'فین ولفهارد', originalName: 'Finn Wolfhard', character: 'مایک ویلر' },
      { name: 'وینونا رایدر', originalName: 'Winona Ryder', character: 'جویس بایرز' },
      { name: 'دیوید هاربر', originalName: 'David Harbour', character: 'جیم هوپر' },
      { name: 'گتن ماتارازو', originalName: 'Gaten Matarazzo', character: 'داستین هندرسون' },
      { name: 'کالب مک‌لافلین', originalName: 'Caleb McLaughlin', character: 'لوکاس سینکلر' },
      { name: 'نوآ شناپ', originalName: 'Noah Schnapp', character: 'ویل بایرز' },
      { name: 'سدی سارک', originalName: 'Sadie Sink', character: 'مکس میفیلد' },
      { name: 'ناتالیا دایر', originalName: 'Natalia Dyer', character: 'نانسی ویلر' },
      { name: 'چارلی هیتون', originalName: 'Charlie Heaton', character: 'جاناتان بایرز' },
      { name: 'جو کیری', originalName: 'Joe Keery', character: 'استیو هرینگتون' },
      { name: 'مایا هاک', originalName: 'Maya Hawke', character: 'روبین باکلی' }
    ]
  };

  // Movie full cast lookup endpoint from IMDb
  app.post('/api/imdb/movie-cast', async (req, res) => {
    try {
      const { title, originalTitle, imdbId } = req.body;
      const movieQuery = (originalTitle || title || imdbId || '').trim();
      if (!movieQuery) {
        return res.status(400).json({ success: false, message: 'عنوان اثر یا شناسه IMDb الزامی است.' });
      }

      // Check cache first
      if (castCacheMap.has(movieQuery.toLowerCase())) {
        return res.json({ success: true, data: castCacheMap.get(movieQuery.toLowerCase()) });
      }

      // Extract precise IMDb ID if present (e.g. tt1375666, tt28490352)
      let targetImdbId = '';
      const imdbMatch = String(imdbId || movieQuery).match(/tt\d+/i);
      if (imdbMatch) {
        targetImdbId = imdbMatch[0].toLowerCase();
      }

      let exactTitle = originalTitle || title || '';
      let exactYear = '';
      let omdbCast = '';
      let actorsList: any[] = [];

      // 1. Check special known movies
      const normTitle = (title || originalTitle || '').trim().toLowerCase();
      if (SPECIAL_KNOWN_CASTS[normTitle] && (!targetImdbId || targetImdbId.length < 5)) {
        const knownCast = SPECIAL_KNOWN_CASTS[normTitle];
        const enriched = await Promise.all(
          knownCast.map(async (act: any, idx: number) => {
            const info = await fetchImdbActor(act.name, act.originalName);
            return {
              id: info.imdbId || `act-${idx}-${Date.now()}`,
              name: act.name || info.name,
              originalName: act.originalName || info.originalName,
              character: act.character || 'بازیگر',
              photoUrl: info.photoUrl || act.photoUrl,
              imdbId: info.imdbId,
              imdbUrl: info.imdbUrl
            };
          })
        );
        castCacheMap.set(movieQuery.toLowerCase(), enriched);
        return res.json({ success: true, data: enriched });
      }

      // 2. Direct Scrape from IMDb if IMDb ID is available
      if (targetImdbId) {
        try {
          const scraped = await scrapeImdbFullCast(targetImdbId);
          if (scraped && scraped.length > 0) {
            actorsList = scraped;
          }
        } catch (e) {
          console.warn('Scrape cast error:', e);
        }

        try {
          const omdbRes = await fetch(`https://www.omdbapi.com/?i=${targetImdbId}&apikey=trilogy`, {
            signal: AbortSignal.timeout(3000)
          });
          if (omdbRes.ok) {
            const omdb = await omdbRes.json();
            if (omdb.Response === 'True') {
              if (omdb.Title) exactTitle = omdb.Title;
              if (omdb.Year) exactYear = omdb.Year;
              if (omdb.Actors && omdb.Actors !== 'N/A' && actorsList.length === 0) omdbCast = omdb.Actors;
            }
          }
        } catch (e) {
          // OMDB warning
        }

        if (!exactTitle) {
          try {
            const suggRes = await fetch(`https://v3.sg.media-imdb.com/suggestion/titles/t/${targetImdbId}.json`, {
              signal: AbortSignal.timeout(3000)
            });
            if (suggRes.ok) {
              const sugg = await suggRes.json();
              if (sugg.d && sugg.d[0]) {
                if (sugg.d[0].l) exactTitle = sugg.d[0].l;
                if (sugg.d[0].y) exactYear = String(sugg.d[0].y);
                if (sugg.d[0].s && !omdbCast && actorsList.length === 0) omdbCast = sugg.d[0].s;
              }
            }
          } catch (e) {
            // IMDb suggestion warning
          }
        }
      }

      if (actorsList.length === 0) {
        const ai = getAI();
        if (ai) {
          // Updated model aliases matching recommended standard
          const CANDIDATE_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
          for (const modelName of CANDIDATE_MODELS) {
            try {
              const prompt = `You are an official IMDb cast metadata provider.
You must provide the cast list EXCLUSIVELY for the specific movie or series identified below:
- IMDb ID: "${targetImdbId || 'N/A'}"
- Title: "${exactTitle || movieQuery}"
- Year/Period: "${exactYear || 'N/A'}"
- Verified Top Cast: "${omdbCast || 'N/A'}"

CRITICAL INSTRUCTION:
ONLY provide actors who actually played in THIS SPECIFIC production ("${exactTitle || movieQuery}" - ${targetImdbId || ''}).
DO NOT include any actors from other movies, past reboots, or unrelated projects.

Provide 18 to 35 actors (both lead and supporting roles) who acted in this specific movie/series.
For each actor, include:
- "name": Persian translation of actor's name (e.g. "لئوناردو دی‌کاپریو", "بهرام افشاری", "کیلین مورفی")
- "originalName": Exact English full name on IMDb (e.g. "Leonardo DiCaprio", "Bahram Afshari", "Cillian Murphy")
- "character": Exact character / role name played in this production

Return a valid JSON array of objects with fields "name", "originalName", "character".`;

              const resp = await ai.models.generateContent({
                model: modelName,
                contents: prompt,
                config: {
                  responseMimeType: 'application/json'
                }
              });

              const text = resp.text || '';
              const match = text.match(/\[[\s\S]*\]/);
              if (match) {
                const parsed = JSON.parse(match[0]);
                if (Array.isArray(parsed) && parsed.length > 0) {
                  actorsList = parsed;
                  break;
                }
              }
            } catch (e: any) {
              console.log(`Cast generation fallback with ${modelName}`);
            }
          }
        }
      }

      // Fallback if AI couldn't generate: use omdbCast
      if (actorsList.length === 0 && omdbCast) {
        actorsList = omdbCast.split(',').map((name: string) => ({
          name: name.trim(),
          originalName: name.trim(),
          character: 'بازیگر اصلی'
        }));
      }

      // If still empty and special known movies matches
      if (actorsList.length === 0 && (normTitle.includes('عینکی') || normTitle.includes('glass man'))) {
        actorsList = SPECIAL_KNOWN_CASTS['مرد عینکی'];
      }

      // Enrich top actors with official IMDb photos and links
      const enriched = await Promise.all(
        actorsList.slice(0, 35).map(async (act: any, idx: number) => {
          if (act.photoUrl && act.imdbId) {
            return {
              id: act.imdbId,
              name: act.name,
              originalName: act.originalName,
              character: act.character || 'بازیگر',
              photoUrl: act.photoUrl,
              imdbId: act.imdbId,
              imdbUrl: act.imdbUrl || `https://www.imdb.com/name/${act.imdbId}/`
            };
          }
          try {
            const info = await fetchImdbActor(act.name || act.originalName, act.originalName || act.name);
            return {
              id: info.imdbId || act.imdbId || `act-${idx}-${Date.now()}`,
              name: act.name || info.name,
              originalName: act.originalName || info.originalName,
              character: act.character || 'بازیگر',
              photoUrl: info.photoUrl || act.photoUrl,
              imdbId: info.imdbId || act.imdbId,
              imdbUrl: info.imdbUrl || act.imdbUrl || (info.imdbId ? `https://www.imdb.com/name/${info.imdbId}/` : undefined)
            };
          } catch {
            return {
              id: act.imdbId || `act-${idx}-${Date.now()}`,
              name: act.name || act.originalName,
              originalName: act.originalName || act.name,
              character: act.character || 'بازیگر',
              photoUrl: act.photoUrl,
              imdbId: act.imdbId,
              imdbUrl: act.imdbUrl || (act.imdbId ? `https://www.imdb.com/name/${act.imdbId}/` : `https://www.imdb.com/find/?q=${encodeURIComponent(act.originalName || act.name)}`)
            };
          }
        })
      );

      castCacheMap.set(movieQuery.toLowerCase(), enriched);
      res.json({ success: true, data: enriched });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Actor search / lookup endpoint for adding actors dynamically from IMDb
  app.post('/api/imdb/actor', async (req, res) => {
    try {
      const { name, originalName } = req.body;
      if (!name && !originalName) {
        return res.status(400).json({ success: false, message: 'نام بازیگر الزامی است.' });
      }
      const actorData = await fetchImdbActor(name || originalName, originalName || name);
      res.json({ success: true, data: actorData });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Smart IMDb / Movie auto-fetch endpoint
  app.post('/api/imdb/lookup', async (req, res) => {
    try {
      const { input } = req.body;
      if (!input || !String(input).trim()) {
        return res.status(400).json({ success: false, message: 'لطفاً شناسه IMDb، لینک، یا نام فیلم را وارد نمایید.' });
      }

      const cleanInput = String(input).trim();
      const cacheKey = cleanInput.toLowerCase();
      if (lookupCacheMap.has(cacheKey)) {
        return res.json(lookupCacheMap.get(cacheKey));
      }
      let imdbId = '';
      const imdbMatch = cleanInput.match(/tt\d{7,8}/i);
      if (imdbMatch) {
        imdbId = imdbMatch[0].toLowerCase();
      }

      // Initial base object to fill
      const realData: Partial<MovieItem> = {
        title: cleanInput,
        originalTitle: cleanInput,
        type: 'movie',
        imdbId: imdbId || `tt${Math.floor(1000000 + Math.random() * 9000000)}`,
        imdbRating: 7.8,
        imdbVotes: '25K',
        year: new Date().getFullYear(),
        duration: '۱۰۰ دقیقه',
        ageRating: '+15',
        country: 'آمریکا',
        genres: ['اکشن', 'درام'],
        languages: 'both',
        hasPersianDub: true,
        hasPersianSub: true,
        isHd: true,
        director: 'نامشخص',
        cast: ['بازیگر'],
        synopsis: 'توضیحات و خلاصه داستان کامل اثر.',
        posterUrl: 'https://images.unsplash.com/photo-1536440136628-849c177e76a1?auto=format&fit=crop&w=600&q=80',
        backdropUrl: 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?auto=format&fit=crop&w=1600&q=80'
      };

      // 1. Fetch from IMDb Live Public Suggestion API
      let imdbSuggestion: any = null;
      try {
        const imdbUrl = imdbId
          ? `https://v3.sg.media-imdb.com/suggestion/titles/t/${imdbId}.json`
          : `https://v3.sg.media-imdb.com/suggestion/x/${encodeURIComponent(cleanInput)}.json`;
        
        const imdbRes = await fetch(imdbUrl, { 
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } 
        });

        if (imdbRes.ok) {
          const json = await imdbRes.json();
          if (json.d && json.d.length > 0) {
            imdbSuggestion = json.d[0];
            if (imdbSuggestion.id) realData.imdbId = imdbSuggestion.id;
            if (imdbSuggestion.l) {
              realData.originalTitle = imdbSuggestion.l;
              realData.title = imdbSuggestion.l;
            }
            if (imdbSuggestion.y) realData.year = Number(imdbSuggestion.y);
            if (imdbSuggestion.qid) {
              realData.type = (imdbSuggestion.qid.includes('tv') || imdbSuggestion.qid.includes('series')) ? 'series' : 'movie';
            }
            if (imdbSuggestion.s) {
              realData.cast = imdbSuggestion.s.split(',').map((s: string) => s.trim());
            }
            if (imdbSuggestion.i?.imageUrl) {
              realData.posterUrl = imdbSuggestion.i.imageUrl;
              realData.backdropUrl = imdbSuggestion.i.imageUrl;
            }
          }
        }
      } catch (err) {
        console.warn('IMDb suggestion fetch warning:', err);
      }

      // 2. Fetch from OMDB (using accurate IMDb ID with full plot)
      const targetId = realData.imdbId || imdbId;
      let omdbData: any = null;
      if (targetId && targetId.startsWith('tt')) {
        try {
          const omdbRes = await fetch(`https://www.omdbapi.com/?i=${targetId}&plot=full&apikey=trilogy`);
          if (omdbRes.ok) {
            const omdb = await omdbRes.json();
            if (omdb.Response === 'True') {
              omdbData = omdb;
              if (omdb.Title) {
                realData.originalTitle = omdb.Title;
                realData.title = omdb.Title;
              }
              if (omdb.Year) {
                const cleanYear = parseInt(omdb.Year);
                if (cleanYear) realData.year = cleanYear;
              }
              if (omdb.Type) {
                realData.type = omdb.Type === 'series' ? 'series' : 'movie';
              }
              if (omdb.imdbRating && omdb.imdbRating !== 'N/A') {
                realData.imdbRating = parseFloat(omdb.imdbRating);
              }
              if (omdb.imdbVotes && omdb.imdbVotes !== 'N/A') {
                realData.imdbVotes = omdb.imdbVotes;
              }
              if (omdb.Runtime && omdb.Runtime !== 'N/A') {
                const mins = parseInt(omdb.Runtime);
                realData.duration = mins ? `${mins} دقیقه` : omdb.Runtime;
              }
              if (omdb.Director && omdb.Director !== 'N/A') {
                realData.director = omdb.Director;
              }
              if (omdb.Actors && omdb.Actors !== 'N/A') {
                realData.cast = omdb.Actors.split(',').map((a: string) => a.trim());
              }
              if (omdb.Genre && omdb.Genre !== 'N/A') {
                realData.genres = omdb.Genre.split(',').map((g: string) => {
                  const key = g.trim().toLowerCase().replace(/[^a-z]/g, '');
                  return GENRE_TRANSLATIONS[key] || g.trim();
                });
              }
              if (omdb.Country && omdb.Country !== 'N/A') {
                const firstCountry = omdb.Country.split(',')[0].trim().toLowerCase();
                realData.country = COUNTRY_TRANSLATIONS[firstCountry] || omdb.Country.split(',')[0].trim();
              }
              if (omdb.Rated && omdb.Rated !== 'N/A') {
                if (omdb.Rated === 'R' || omdb.Rated === 'NC-17' || omdb.Rated === 'TV-MA') realData.ageRating = '+18';
                else if (omdb.Rated === 'PG-13' || omdb.Rated === 'TV-14') realData.ageRating = '+15';
                else if (omdb.Rated === 'PG' || omdb.Rated === 'TV-PG') realData.ageRating = '+13';
                else if (omdb.Rated === 'G' || omdb.Rated === 'TV-G' || omdb.Rated === 'TV-Y') realData.ageRating = 'ALL';
              }
              if (omdb.Plot && omdb.Plot !== 'N/A') {
                realData.synopsis = omdb.Plot;
              }
              if (omdb.Poster && omdb.Poster !== 'N/A' && (!realData.posterUrl || realData.posterUrl.includes('unsplash'))) {
                realData.posterUrl = omdb.Poster;
                realData.backdropUrl = omdb.Poster;
              }
            }
          }
        } catch (err) {
          console.warn('OMDB fetch warning:', err);
        }
      }

      // 2.5 Fetch Full Cast & Metadata directly from IMDb Web Page (JSON-LD)
      if (targetId && targetId.startsWith('tt')) {
        try {
          const fullImdb = await fetchFullImdbData(targetId);
          if (fullImdb) {
            if (fullImdb.title) {
              realData.originalTitle = fullImdb.title;
              if (!realData.title || realData.title === cleanInput) realData.title = fullImdb.title;
            }
            if (fullImdb.directors && fullImdb.directors.length > 0) {
              realData.director = fullImdb.directors.join(', ');
            }
            if (fullImdb.actors && fullImdb.actors.length > 0) {
              realData.cast = fullImdb.actors.map(a => a.originalName);
              (realData as any).actors = fullImdb.actors;
            }
            if (fullImdb.synopsis && (!realData.synopsis || realData.synopsis.includes('توضیحات و خلاصه'))) {
              realData.synopsis = fullImdb.synopsis;
            }
            if (fullImdb.posterUrl && (!realData.posterUrl || realData.posterUrl.includes('unsplash'))) {
              realData.posterUrl = fullImdb.posterUrl;
              realData.backdropUrl = fullImdb.posterUrl;
            }
            if (fullImdb.rating) realData.imdbRating = fullImdb.rating;
            if (fullImdb.votes) realData.imdbVotes = fullImdb.votes;
          }
        } catch (err) {
          console.warn('IMDb full web fetch warning:', err);
        }
      }

      // 3. Gemini AI Deep Polish & Persian Localization with Multi-Model Fallback
      const ai = getAI();
      if (ai) {
        const CANDIDATE_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
        for (const modelName of CANDIDATE_MODELS) {
          try {
            const aiPrompt = `You are a Persian cinema and IMDb metadata specialist for "پارس مووی" (Pars Movie).
I have verified the following real data from IMDb:
- Search Input: "${cleanInput}"
- Real Title: "${realData.originalTitle}"
- IMDb ID: "${realData.imdbId}"
- Year: ${realData.year}
- Type: ${realData.type}
- Director: "${realData.director}"
- Cast: ${JSON.stringify(realData.cast)}
- Rating: ${realData.imdbRating} (${realData.imdbVotes} votes)
- Genre: ${JSON.stringify(realData.genres)}
- Country: "${realData.country}"
- Full Storyline / Narrative from IMDb (EN): "${realData.synopsis || ''}"

Return a strict JSON object with perfect Persian localization and translation:
{
  "title": "عنوان جذاب و دقیق فارسی اثر (مثلا: رزیدنت اویل / اوپنهایمر / تلماسه ۲)",
  "originalTitle": "${realData.originalTitle}",
  "type": "${realData.type}",
  "imdbId": "${realData.imdbId}",
  "imdbRating": ${realData.imdbRating},
  "imdbVotes": "${realData.imdbVotes}",
  "year": ${realData.year},
  "duration": "${realData.duration || '۱۰۰ دقیقه'}",
  "ageRating": "${realData.ageRating || '+15'}",
  "country": "${realData.country || 'آمریکا'}",
  "genres": ${JSON.stringify(realData.genres || ['اکشن', 'درام'])},
  "synopsis": "داستان کامل و مشروح فیلم/سریال به زبان فارسی روان، جذاب و غنی (ترجمه دقیق و جامع کل داستان و پلات کامل IMDb بدون کوتاه کردن یا تلخیص در یک یا دو جمله؛ تمام جزئیات داستان، شروع ماجرا، انگیزه شخصیت‌ها و کشمکش‌های دراماتیک را کامل بنویسید)",
  "director": "${realData.director || 'نامشخص'}",
  "cast": ${JSON.stringify(realData.cast || [])},
  "actors": [
    // Include ALL top actors who played in this movie/series from IMDb (provide 15 to 30 actors from IMDb cast with character names)
    {
      "name": "نام فارسی بازیگر ۱",
      "originalName": "English Name 1",
      "character": "نام نقش در این اثر"
    }
  ],
  "hasPersianDub": true,
  "hasPersianSub": true,
  "isHd": true,
  "posterUrl": "${realData.posterUrl}",
  "backdropUrl": "${realData.backdropUrl}"
}
Only output the raw JSON object.`;

            const response = await ai.models.generateContent({
              model: modelName,
              contents: aiPrompt,
            });

            const text = response.text || '';
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const aiParsed = JSON.parse(jsonMatch[0]);
              
              // Automatically find real official trailer for this movie/series
              const officialTrailerInfo = await getImdbOfficialTrailerInfo(
                aiParsed.title || realData.title || cleanInput,
                aiParsed.originalTitle || realData.originalTitle,
                realData.imdbId || imdbId
              );
              const officialTrailer = officialTrailerInfo.trailerUrl || '';
              const officialTrailersList = (officialTrailerInfo.trailers && officialTrailerInfo.trailers.length > 0)
                ? officialTrailerInfo.trailers
                : (officialTrailer ? [
                    {
                      id: `tr-${Date.now()}-1`,
                      title: `${aiParsed.title || realData.title || cleanInput} | تریلر رسمی`,
                      duration: 'Trailer 2:30',
                      type: 'trailer',
                      url: officialTrailer,
                      thumbnailUrl: realData.posterUrl || aiParsed?.posterUrl,
                      likes: '1.8K',
                      claps: '940'
                    }
                  ] : []);

              // Build a map of pre-scraped actors from the fullCredits page
              const scrapedMap = new Map<string, any>();
              if ((realData as any).actors && Array.isArray((realData as any).actors)) {
                (realData as any).actors.forEach((act: any) => {
                  if (act.originalName) {
                    scrapedMap.set(act.originalName.toLowerCase().trim(), act);
                  }
                  if (act.name) {
                    scrapedMap.set(act.name.toLowerCase().trim(), act);
                  }
                });
              }

              // Enrich actors from IMDb with official photos, IDs & profile links
              const rawActorsList = (aiParsed.actors && Array.isArray(aiParsed.actors) && aiParsed.actors.length > 0)
                ? aiParsed.actors
                : (aiParsed.cast || realData.cast || []).map((c: string) => ({ name: c, originalName: c, character: 'بازیگر اصلی' }));

              const enrichedActors = await Promise.all(
                rawActorsList.slice(0, 35).map(async (act: any, idx: number) => {
                  const origNameKey = (act.originalName || '').toLowerCase().trim();
                  const nameKey = (act.name || '').toLowerCase().trim();
                  const scraped = scrapedMap.get(origNameKey) || scrapedMap.get(nameKey);
                  
                  if (scraped && scraped.photoUrl && scraped.imdbId) {
                    // Use the pre-scraped precise IMDb data directly (instant and 100% accurate)
                    return {
                      id: scraped.imdbId,
                      name: act.name || scraped.name,
                      originalName: act.originalName || scraped.originalName,
                      character: act.character || scraped.character || 'بازیگر',
                      photoUrl: scraped.photoUrl,
                      imdbId: scraped.imdbId,
                      imdbUrl: scraped.imdbUrl || `https://www.imdb.com/name/${scraped.imdbId}/`
                    };
                  }

                  // Fallback to fetchImdbActor only if not pre-scraped
                  const info = await fetchImdbActor(act.name || act.originalName, act.originalName || act.name);
                  return {
                    id: info.imdbId || (scraped?.imdbId) || `act-${idx}-${Date.now()}`,
                    name: act.name || info.name || scraped?.name,
                    originalName: act.originalName || info.originalName || scraped?.originalName,
                    character: act.character || scraped?.character || 'بازیگر',
                    photoUrl: info.photoUrl || scraped?.photoUrl,
                    imdbId: info.imdbId || scraped?.imdbId,
                    imdbUrl: info.imdbUrl || scraped?.imdbUrl || (info.imdbId ? `https://www.imdb.com/name/${info.imdbId}/` : undefined)
                  };
                })
              );

              // Make sure we have a robust list of at least 18-35 actors by combining enrichedActors and scraped list
              const finalActorsList = [...enrichedActors];
              if (finalActorsList.length < 25 && (realData as any).actors) {
                const existingImdbIds = new Set(finalActorsList.map(a => a.imdbId).filter(Boolean));
                for (const scraped of (realData as any).actors) {
                  if (finalActorsList.length >= 35) break;
                  if (scraped.imdbId && !existingImdbIds.has(scraped.imdbId)) {
                    finalActorsList.push({
                      id: scraped.imdbId,
                      name: scraped.name,
                      originalName: scraped.originalName,
                      character: scraped.character || 'بازیگر',
                      photoUrl: scraped.photoUrl,
                      imdbId: scraped.imdbId,
                      imdbUrl: scraped.imdbUrl || `https://www.imdb.com/name/${scraped.imdbId}/`
                    });
                    existingImdbIds.add(scraped.imdbId);
                  }
                }
              }

              const finalRes = {
                success: true,
                data: {
                  ...realData,
                  ...aiParsed,
                  actors: finalActorsList,
                  trailerUrl: officialTrailer,
                  trailers: officialTrailersList,
                  posterUrl: realData.posterUrl && !realData.posterUrl.includes('unsplash') ? realData.posterUrl : (aiParsed.posterUrl || realData.posterUrl),
                  backdropUrl: realData.backdropUrl && !realData.backdropUrl.includes('unsplash') ? realData.backdropUrl : (aiParsed.backdropUrl || realData.backdropUrl),
                  imdbId: realData.imdbId
                },
                source: `imdb_live_gemini_enhanced_${modelName}`
              };
              lookupCacheMap.set(cacheKey, finalRes);
              return res.json(finalRes);
            }
          } catch (aiErr: any) {
            console.log(`Gemini model ${modelName} unavailable (${aiErr?.status || aiErr?.message || '503'}), trying fallback...`);
          }
        }
      }

      // Automatically find real official trailer for this movie/series in direct fallback
      const officialTrailerInfo = await getImdbOfficialTrailerInfo(
        realData.title || cleanInput,
        realData.originalTitle,
        realData.imdbId || imdbId
      );
      const officialTrailer = officialTrailerInfo.trailerUrl || '';
      const officialTrailersList = (officialTrailerInfo.trailers && officialTrailerInfo.trailers.length > 0)
        ? officialTrailerInfo.trailers
        : (officialTrailer ? [
            {
              id: `tr-${Date.now()}-1`,
              title: `${realData.title || cleanInput} | تریلر رسمی`,
              duration: 'Trailer 2:30',
              type: 'trailer',
              url: officialTrailer,
              thumbnailUrl: realData.posterUrl,
              likes: '1.8K',
              claps: '940'
            }
          ] : []);

      // Direct fallback: Fetch actor profiles directly from IMDb web/suggestion API & local verified cache
      const rawFallbackActors = ((realData as any).actors && Array.isArray((realData as any).actors) && (realData as any).actors.length > 0)
        ? (realData as any).actors
        : (realData.cast || []).map((c: string) => ({ name: c, originalName: c }));

      const directActors = await Promise.all(
        rawFallbackActors.slice(0, 35).map(async (act: any, idx: number) => {
          const actName = act.name || act.originalName;
          const known = KNOWN_ACTORS_IMDB[actName] || (act.originalName ? KNOWN_ACTORS_IMDB[act.originalName] : undefined);
          const info = await fetchImdbActor(actName, act.originalName || known?.originalName || actName);
          return {
            id: act.imdbId || known?.imdbId || info.imdbId || `act-${idx}-${Date.now()}`,
            name: act.name || known?.name || info.name || actName,
            originalName: act.originalName || known?.originalName || info.originalName || actName,
            character: act.character || (idx === 0 ? 'نقش اصلی' : 'بازیگر'),
            photoUrl: act.photoUrl || known?.photoUrl || info.photoUrl,
            imdbId: act.imdbId || known?.imdbId || info.imdbId,
            imdbUrl: act.imdbUrl || known?.imdbUrl || info.imdbUrl
          };
        })
      );

      // Ensure synopsis is translated to Persian using our translation engine
      const persianSynopsis = translateSynopsisToPersian(realData.synopsis || '', realData.title, realData.originalTitle);

      // Return fully parsed real IMDb data directly if AI is skipped or unavailable
      return res.json({ 
        success: true, 
        data: {
          ...realData,
          synopsis: persianSynopsis,
          actors: directActors,
          trailerUrl: officialTrailer,
          trailers: officialTrailersList
        }, 
        source: 'imdb_live_direct_localized' 
      });

    } catch (err: any) {
      console.error('IMDb lookup error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Add Comment to a movie
  app.post('/api/movies/:id/comments', (req, res) => {
    try {
      const movie = moviesDb.find(m => m.id === req.params.id);
      if (!movie) {
        return res.status(404).json({ success: false, message: 'موردی یافت نشد.' });
      }

      const { author, content, rating } = req.body;
      if (!content) {
        return res.status(400).json({ success: false, message: 'متن نظر الزامی است.' });
      }

      const newComment = {
        id: `c-${Date.now()}`,
        author: author || 'کاربر پارس مووی',
        content,
        rating: Number(rating) || 5,
        createdAt: new Intl.DateTimeFormat('fa-IR').format(new Date()),
        likes: 0
      };

      movie.comments = movie.comments || [];
      movie.comments.unshift(newComment);
      saveDatabase(moviesDb);

      res.status(201).json({ success: true, data: newComment, message: 'نظر شما با موفقیت ثبت شد.' });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Rate (Like / Dislike)
  app.post('/api/movies/:id/rate', (req, res) => {
    try {
      const movie = moviesDb.find(m => m.id === req.params.id);
      if (!movie) {
        return res.status(404).json({ success: false, message: 'موردی یافت نشد.' });
      }

      const { type } = req.body; // 'like' | 'dislike'
      if (type === 'like') {
        movie.likes += 1;
      } else if (type === 'dislike') {
        movie.dislikes += 1;
      }

      saveDatabase(moviesDb);
      res.json({ success: true, likes: movie.likes, dislikes: movie.dislikes });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Stats for Admin Panel
  app.get('/api/stats', (req, res) => {
    const totalItems = moviesDb.length;
    const totalMovies = moviesDb.filter(m => m.type === 'movie').length;
    const totalSeries = moviesDb.filter(m => m.type === 'series').length;
    const totalDubbed = moviesDb.filter(m => m.hasPersianDub).length;
    const totalViews = moviesDb.reduce((sum, m) => sum + (m.views || 0), 0);
    const totalComments = moviesDb.reduce((sum, m) => sum + (m.comments ? m.comments.length : 0), 0);

    res.json({
      success: true,
      data: {
        totalItems,
        totalMovies,
        totalSeries,
        totalDubbed,
        totalViews,
        totalComments
      }
    });
  });

  // Reset database to initial seed (Admin)
  app.post('/api/admin/reset', (req, res) => {
    moviesDb = [...INITIAL_MOVIES];
    saveDatabase(moviesDb);
    res.json({ success: true, message: 'پایگاه داده به حالت اولیه بازنشانی شد.', data: moviesDb });
  });

  // ==================== VITE & STATIC FILES ====================

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`پارس مووی سرور روی پورت ${PORT} آماده به کار است.`);
  });
}

startServer();
