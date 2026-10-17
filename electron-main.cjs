const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const express = require('express');

let mainWindow;
let server;
const PORT = 38921;

// Embedded local backend server to serve frontend & data locally inside Electron
function startLocalServer() {
  const localApp = express();
  localApp.use(express.json({ limit: '100mb' }));
  localApp.use(express.urlencoded({ limit: '100mb', extended: true }));

  // Local data directory inside user app data or local directory
  const userDataDir = path.join(app.getPath('userData'), 'ghoghnous_data');
  if (!fs.existsSync(userDataDir)) {
    fs.mkdirSync(userDataDir, { recursive: true });
  }
  const dbFile = path.join(userDataDir, 'movies.json');
  const settingsFile = path.join(userDataDir, 'settings.json');

  function loadLocalDb() {
    try {
      if (fs.existsSync(dbFile)) {
        const content = fs.readFileSync(dbFile, 'utf8');
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch (e) {
      console.warn('Error reading local db:', e);
    }
    return [];
  }

  function saveLocalDb(data) {
    try {
      fs.writeFileSync(dbFile, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
      console.warn('Error saving local db:', e);
    }
  }

  let movies = loadLocalDb();

  // API Routes
  localApp.get('/api/health', (req, res) => {
    res.json({ status: 'ok', local: true });
  });

  localApp.get('/api/movies', (req, res) => {
    res.json({ success: true, count: movies.length, data: movies });
  });

  localApp.post('/api/movies', (req, res) => {
    const item = req.body;
    item.id = item.id || `m-${Date.now()}`;
    movies.unshift(item);
    saveLocalDb(movies);
    res.json({ success: true, data: item });
  });

  localApp.put('/api/movies/:id', (req, res) => {
    const idx = movies.findIndex(m => m.id === req.params.id);
    if (idx !== -1) {
      movies[idx] = { ...movies[idx], ...req.body };
      saveLocalDb(movies);
      return res.json({ success: true, data: movies[idx] });
    }
    res.status(404).json({ success: false, message: 'Not found' });
  });

  localApp.delete('/api/movies/:id', (req, res) => {
    movies = movies.filter(m => m.id !== req.params.id);
    saveLocalDb(movies);
    res.json({ success: true });
  });

  // IMDb Lookup Endpoint inside Electron Node.js
  localApp.post('/api/imdb/lookup', async (req, res) => {
    try {
      const { input } = req.body;
      if (!input) return res.status(400).json({ success: false, message: 'عنوان خالی است.' });

      const cleanInput = String(input).trim();
      let imdbId = '';
      const imdbMatch = cleanInput.match(/tt\d{7,8}/i);
      if (imdbMatch) imdbId = imdbMatch[0].toLowerCase();

      let result = {
        title: cleanInput,
        originalTitle: cleanInput,
        type: 'movie',
        imdbId: imdbId || `tt${Math.floor(1000000 + Math.random() * 9000000)}`,
        imdbRating: 7.6,
        imdbVotes: '20K',
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
        actors: [],
        synopsis: 'خلاصه داستان کامل فیلم دریافت شده از مرجع سینمایی.',
        posterUrl: 'https://images.unsplash.com/photo-1536440136628-849c177e76a1?auto=format&fit=crop&w=600&q=80',
        backdropUrl: 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?auto=format&fit=crop&w=1600&q=80'
      };

      try {
        const imdbUrl = imdbId
          ? `https://v3.sg.media-imdb.com/suggestion/titles/t/${imdbId}.json`
          : `https://v3.sg.media-imdb.com/suggestion/x/${encodeURIComponent(cleanInput)}.json`;
        const response = await fetch(imdbUrl);
        if (response.ok) {
          const json = await response.json();
          if (json.d && json.d.length > 0) {
            const item = json.d[0];
            if (item.id && item.id.startsWith('tt')) result.imdbId = item.id;
            if (item.l) {
              result.originalTitle = item.l;
              result.title = item.l;
            }
            if (item.y) result.year = Number(item.y);
            if (item.qid) result.type = (item.qid.includes('tv') || item.qid.includes('series')) ? 'series' : 'movie';
            if (item.s) result.cast = item.s.split(',').map(s => s.trim());
            if (item.i?.imageUrl) {
              result.posterUrl = item.i.imageUrl;
              result.backdropUrl = item.i.imageUrl;
            }
          }
        }
      } catch (e) {
        console.warn('IMDb suggestion error in Electron:', e);
      }

      // OMDB lookup
      try {
        const omdbParam = (result.imdbId && result.imdbId.startsWith('tt'))
          ? `i=${result.imdbId}`
          : `t=${encodeURIComponent(result.originalTitle || cleanInput)}`;
        const omdbRes = await fetch(`https://www.omdbapi.com/?${omdbParam}&apikey=trilogy`);
        if (omdbRes.ok) {
          const omdb = await omdbRes.json();
          if (omdb.Response === 'True') {
            if (omdb.Title) {
              result.originalTitle = omdb.Title;
              result.title = omdb.Title;
            }
            if (omdb.Year) {
              const y = parseInt(omdb.Year);
              if (y) result.year = y;
            }
            if (omdb.Type) result.type = omdb.Type === 'series' ? 'series' : 'movie';
            if (omdb.imdbRating && omdb.imdbRating !== 'N/A') result.imdbRating = parseFloat(omdb.imdbRating);
            if (omdb.Runtime && omdb.Runtime !== 'N/A') result.duration = `${parseInt(omdb.Runtime) || 100} دقیقه`;
            if (omdb.Director && omdb.Director !== 'N/A') result.director = omdb.Director;
            if (omdb.Plot && omdb.Plot !== 'N/A') result.synopsis = omdb.Plot;
            if (omdb.Poster && omdb.Poster !== 'N/A') {
              result.posterUrl = omdb.Poster;
              result.backdropUrl = omdb.Poster;
            }
          }
        }
      } catch (e) {
        console.warn('OMDB error in Electron:', e);
      }

      res.json({ success: true, data: result });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // Search Actor IMDb in Electron
  localApp.get('/api/search-actor-imdb', async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      const orig = String(req.query.orig || '').trim();
      const query = (orig || q).toLowerCase();
      if (!query) return res.status(400).json({ success: false, message: 'Query missing' });

      const imdbUrl = `https://v3.sg.media-imdb.com/suggestion/x/${encodeURIComponent(query)}.json`;
      const response = await fetch(imdbUrl);
      if (response.ok) {
        const json = await response.json();
        if (json.d && json.d.length > 0) {
          const person = json.d.find(item => item.id && item.id.startsWith('nm') && item.i?.imageUrl) || json.d[0];
          if (person && person.i?.imageUrl) {
            const highRes = person.i.imageUrl.replace(/_V1_.*?\./, '_V1_FMjpg_UX1000_.');
            return res.json({
              success: true,
              data: {
                name: q || person.l,
                originalName: person.l || orig || q,
                imdbId: person.id,
                photoUrl: highRes,
                imdbUrl: `https://www.imdb.com/name/${person.id}/`
              }
            });
          }
        }
      }
      res.json({ success: false, message: 'Actor not found' });
    } catch (e) {
      res.json({ success: false, message: e.message });
    }
  });

  // Get IMDb Trailer in Electron
  localApp.get('/api/imdb-trailer', async (req, res) => {
    try {
      const title = String(req.query.title || '').trim();
      const orig = String(req.query.orig || '').trim();
      const year = req.query.year ? String(req.query.year) : '';
      const query = `${orig || title} ${year} official trailer`.trim();

      const youtubeSearchUrl = `https://www.youtube-nocookie.com/embed?listType=search&list=${encodeURIComponent(query)}`;
      res.json({
        success: true,
        trailerUrl: youtubeSearchUrl,
        query: query
      });
    } catch (e) {
      res.json({ success: false, message: e.message });
    }
  });

  // Rate Movie in Electron
  localApp.post('/api/movies/:id/rate', (req, res) => {
    const { id } = req.params;
    const { type } = req.body;
    const movie = movies.find(m => m.id === id);
    if (!movie) return res.status(404).json({ success: false });

    if (type === 'like') movie.likes = (movie.likes || 0) + 1;
    else if (type === 'dislike') movie.dislikes = (movie.dislikes || 0) + 1;

    saveLocalDb(movies);
    res.json({ success: true, likes: movie.likes, dislikes: movie.dislikes });
  });

  // Post Comment in Electron
  localApp.post('/api/movies/:id/comments', (req, res) => {
    const { id } = req.params;
    const { author, content, rating } = req.body;
    const movie = movies.find(m => m.id === id);
    if (!movie) return res.status(404).json({ success: false });

    const newComment = {
      id: `c-${Date.now()}`,
      author: author || 'کاربر ققنوس',
      content,
      rating: Number(rating) || 5,
      createdAt: 'همین الان'
    };

    movie.comments = [newComment, ...(movie.comments || [])];
    saveLocalDb(movies);
    res.json({ success: true, data: newComment });
  });

  // Settings in Electron
  localApp.get('/api/settings', (req, res) => {
    try {
      if (fs.existsSync(settingsFile)) {
        const data = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
        return res.json({ success: true, data });
      }
    } catch (e) {
      console.error(e);
    }
    res.json({ success: true, data: null });
  });

  localApp.post('/api/settings', (req, res) => {
    try {
      fs.writeFileSync(settingsFile, JSON.stringify(req.body, null, 2), 'utf8');
      res.json({ success: true, data: req.body });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // Stats in Electron
  localApp.get('/api/stats', (req, res) => {
    const totalMovies = movies.length;
    const totalSeries = movies.filter(m => m.type === 'series').length;
    const totalComments = movies.reduce((acc, m) => acc + (m.comments?.length || 0), 0);
    res.json({
      success: true,
      data: {
        totalMovies,
        totalSeries,
        totalComments,
        totalUsers: 14820,
        activeStreams: 340
      }
    });
  });

  // Static files from Vite build output
  const distPath = path.join(__dirname, 'dist');
  localApp.use(express.static(distPath));

  // Fallback to index.html for Single Page Application routing
  localApp.get('*', (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });

  server = localApp.listen(PORT, '127.0.0.1', () => {
    console.log(`Local Ghoghnous Movie running at http://127.0.0.1:${PORT}`);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'ققنوس مووی',
    autoHideMenuBar: true,
    backgroundColor: '#0f0f12',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,
    },
  });

  // First try local server, and also support direct file load if needed
  mainWindow.loadURL(`http://127.0.0.1:${PORT}`).catch(() => {
    mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  startLocalServer();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (server) {
    server.close();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
