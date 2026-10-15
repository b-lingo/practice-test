import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

// Try loading environment variables from .env file if present (Node.js 20.6+)
try {
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile();
  }
} catch (e) {
  // .env file might not exist, ignore
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read Firebase web config to verify tokens
let firebaseConfig = {
  projectId: 'balmy-gear-p5p7n',
  apiKey: 'AIzaSyCNrtSZuQGBoAYDwfQ0ATD4ImPQdSzAVBc'
};
try {
  const cfgPath = path.join(__dirname, 'firebase-applet-config.json');
  if (fs.existsSync(cfgPath)) {
    const raw = fs.readFileSync(cfgPath, 'utf8');
    const parsed = JSON.parse(raw);
    firebaseConfig.projectId = parsed.projectId || firebaseConfig.projectId;
    firebaseConfig.apiKey = parsed.apiKey || firebaseConfig.apiKey;
  }
} catch (e) {
  console.warn('Could not read firebase-applet-config.json:', e.message);
}

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve static assets from root directory
app.use(express.static(__dirname));

/* ----------------------------------------------------
   In-Memory Token Cache
---------------------------------------------------- */
const tokenCache = new Map(); // token -> { uid, email, expiresAt }

async function verifyFirebaseIdToken(token) {
  if (!token || typeof token !== 'string') return null;

  const now = Date.now();
  const cached = tokenCache.get(token);
  if (cached && cached.expiresAt > now) {
    return { uid: cached.uid, email: cached.email };
  }

  // Verify against Google Identity Toolkit endpoint
  try {
    const verifyUrl = `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(firebaseConfig.apiKey)}`;
    const resp = await fetch(verifyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: token })
    });

    if (!resp.ok) {
      return null;
    }

    const data = await resp.json();
    if (!data.users || !data.users[0] || !data.users[0].localId) {
      return null;
    }

    const user = data.users[0];
    const uid = user.localId;
    const email = user.email || '';

    // Cache for 5 minutes or 300s
    tokenCache.set(token, {
      uid,
      email,
      expiresAt: now + 5 * 60 * 1000
    });

    // Cleanup cache periodically if too large
    if (tokenCache.size > 2000) {
      for (const [k, v] of tokenCache.entries()) {
        if (v.expiresAt <= now) tokenCache.delete(k);
      }
    }

    return { uid, email };
  } catch (err) {
    console.error('Error verifying Firebase ID token:', err.message);
    return null;
  }
}

/* ----------------------------------------------------
   Rate Limiting (Max 30 req/min and 800 req/day per teacher)
---------------------------------------------------- */
const userRateLimits = new Map(); // uid -> { minuteTimestamps: number[], dayDate: string, dayCount: number }

function checkTeacherRateLimit(uid) {
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  let record = userRateLimits.get(uid);
  if (!record) {
    record = { minuteTimestamps: [], dayDate: today, dayCount: 0 };
    userRateLimits.set(uid, record);
  }

  // Clean minute timestamps older than 60 seconds
  record.minuteTimestamps = record.minuteTimestamps.filter(t => now - t < 60000);

  // Reset daily count when date advances
  if (record.dayDate !== today) {
    record.dayDate = today;
    record.dayCount = 0;
  }

  // Check 30 requests per minute limit
  if (record.minuteTimestamps.length >= 30) {
    return {
      allowed: false,
      reason: 'Đã vượt quá giới hạn 30 yêu cầu mỗi phút. Vui lòng thử lại sau giây lát.'
    };
  }

  // Check 800 requests per day limit
  if (record.dayCount >= 800) {
    return {
      allowed: false,
      reason: 'Đã vượt quá giới hạn 800 yêu cầu mỗi ngày cho tài khoản giáo viên này.'
    };
  }

  // Record this request
  record.minuteTimestamps.push(now);
  record.dayCount++;
  return { allowed: true };
}

/* ----------------------------------------------------
   POST /api/ai
---------------------------------------------------- */
app.post('/api/ai', async (req, res) => {
  console.log('Gemini Key:', process.env.GEMINI_API_KEY ? (process.env.GEMINI_API_KEY.length + ' chars, starts with ' + process.env.GEMINI_API_KEY.slice(0, 2) + ', ends with ' + process.env.GEMINI_API_KEY.slice(-2)) : 'MISSING');

  // 1. Authorization header check
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'Yêu cầu không được xác thực. Vui lòng đăng nhập tài khoản giáo viên (Thiếu Bearer token).'
    });
  }

  const idToken = authHeader.slice(7).trim();
  if (!idToken) {
    return res.status(401).json({
      error: 'Token xác thực trống. Vui lòng đăng nhập lại.'
    });
  }

  // 2. Validate Firebase ID token
  const authUser = await verifyFirebaseIdToken(idToken);
  if (!authUser || !authUser.uid) {
    return res.status(401).json({
      error: 'Phiên làm việc đã hết hạn hoặc token không hợp lệ. Vui lòng đăng nhập lại.'
    });
  }

  // 3. Enforce Teacher Rate Limiting (30/min, 800/day)
  const rateLimit = checkTeacherRateLimit(authUser.uid);
  if (!rateLimit.allowed) {
    return res.status(429).json({
      error: rateLimit.reason
    });
  }

  // 4. Validate request prompt
  const { prompt } = req.body || {};
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({
      error: 'Thiếu nội dung prompt yêu cầu cho AI.'
    });
  }

  // 5. Server-side GEMINI_API_KEY and GEMINI_MODEL
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  const keyLen = apiKey.length;
  const maskedKey = keyLen > 8 ? `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}` : (keyLen > 0 ? '****' : '(chưa cấu hình)');

  console.log(`[Server /api/ai] Yêu cầu từ UID=${authUser.uid}:`);
  console.log(`  - GEMINI_API_KEY: tồn tại=${keyLen > 0}, độ dài=${keyLen}, dạng ẩn=${maskedKey}`);

  if (!apiKey) {
    console.error('[Server /api/ai] LỖI: process.env.GEMINI_API_KEY chưa được cấu hình trên máy chủ!');
    return res.status(500).json({
      error: 'GEMINI_API_KEY chưa được cấu hình trên máy chủ. Vui lòng thiết lập biến môi trường GEMINI_API_KEY.'
    });
  }

  // Model selection: sanitize and ensure modern supported model (gemini-3.8-flash)
  let model = (process.env.GEMINI_MODEL || '').trim();
  if (model.startsWith('models/')) {
    model = model.slice(7);
  }
  const deprecatedModels = ['gemini-2.5-flash', 'gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-pro', 'gemini-2.0-flash', 'gemini-2.0-pro'];
  if (!model || deprecatedModels.includes(model)) {
    model = 'gemini-3.8-flash';
  }
  console.log(`  - GEMINI_MODEL: sử dụng '${model}'`);

  // 6. Call Gemini API
  try {
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const geminiPayload = {
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: {
        maxOutputTokens: 24000,
        temperature: 0.7
      }
    };

    const resp = await fetch(geminiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'aistudio-build'
      },
      body: JSON.stringify(geminiPayload)
    });

    console.log(`[Server /api/ai] Gemini API phản hồi HTTP status = ${resp.status}`);

    // Handle rate limits and errors per requirements
    if (resp.status === 429) {
      let errDetail = '';
      try {
        const j = await resp.json();
        errDetail = j.error?.message || '';
      } catch (e) {}
      return res.status(429).json({
        error: 'Gemini báo quá tải hoặc đạt giới hạn tần suất (429)',
        detail: errDetail
      });
    }

    if (resp.status === 400 || resp.status === 401 || resp.status === 403) {
      let errDetail = '';
      try {
        const j = await resp.json();
        errDetail = j.error?.message || '';
      } catch (e) {}
      return res.status(403).json({
        error: `Khóa hoặc quyền truy cập Gemini không hợp lệ (${resp.status})`,
        detail: errDetail
      });
    }

    if (!resp.ok) {
      let errDetail = '';
      try {
        const j = await resp.json();
        errDetail = j.error?.message || (await resp.text()).slice(0, 200);
      } catch (e) {}
      return res.status(502).json({
        error: `Lỗi kết nối Gemini API (${resp.status})`,
        detail: errDetail
      });
    }

    const data = await resp.json();
    const candidate = data.candidates && data.candidates[0];
    if (!candidate || !candidate.content) {
      return res.status(502).json({
        error: 'Gemini không trả về nội dung' + (candidate && candidate.finishReason ? ` (${candidate.finishReason})` : '')
      });
    }

    const text = (candidate.content.parts || []).map(p => p.text || '').join('');
    const truncated = candidate.finishReason === 'MAX_TOKENS';

    return res.json({
      text,
      truncated
    });

  } catch (err) {
    console.error('Gemini call unexpected error:', err);
    return res.status(502).json({
      error: 'Lỗi máy chủ khi gọi dịch vụ AI Gemini',
      detail: err.message
    });
  }
});

/* ----------------------------------------------------
   Persistent Store for Assignments and Submissions
---------------------------------------------------- */
const DATA_DIR = path.join(__dirname, 'data');
const ASSIGNMENTS_FILE = path.join(DATA_DIR, 'assignments.json');

try {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
} catch (e) {
  console.warn('Could not create data directory:', e.message);
}

// In-memory assignment map: code (uppercase) -> assignment record
const assignments = new Map();

function loadAssignmentsFromDisk() {
  try {
    if (fs.existsSync(ASSIGNMENTS_FILE)) {
      const raw = fs.readFileSync(ASSIGNMENTS_FILE, 'utf8');
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        for (const item of data) {
          if (item && item.code) {
            assignments.set(String(item.code).toUpperCase(), item);
          }
        }
      }
    }
  } catch (e) {
    console.warn('Error loading assignments from disk:', e.message);
  }
}
loadAssignmentsFromDisk();

function saveAssignmentsToDisk() {
  try {
    const list = Array.from(assignments.values());
    fs.writeFileSync(ASSIGNMENTS_FILE, JSON.stringify(list, null, 2), 'utf8');
  } catch (e) {
    console.error('Error saving assignments to disk:', e.message);
  }
}

/* ----------------------------------------------------
   Student Rate Limiting (Max 30 req/min per IP)
---------------------------------------------------- */
const studentIpLimits = new Map(); // ip -> timestamp[]

function checkStudentRateLimit(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const ip = (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : '') ||
             req.socket?.remoteAddress ||
             req.ip ||
             'unknown-ip';

  const now = Date.now();
  let timestamps = studentIpLimits.get(ip) || [];
  timestamps = timestamps.filter(t => now - t < 60000);

  if (timestamps.length >= 30) {
    studentIpLimits.set(ip, timestamps);
    return {
      allowed: false,
      ip,
      reason: 'Đã vượt quá giới hạn 30 yêu cầu mỗi phút từ địa chỉ IP của bạn. Vui lòng thử lại sau giây lát.'
    };
  }

  timestamps.push(now);
  studentIpLimits.set(ip, timestamps);

  // Periodically clean stale IPs
  if (studentIpLimits.size > 5000) {
    for (const [key, list] of studentIpLimits.entries()) {
      const active = list.filter(t => now - t < 60000);
      if (active.length === 0) studentIpLimits.delete(key);
      else studentIpLimits.set(key, active);
    }
  }

  return { allowed: true, ip };
}

/* ----------------------------------------------------
   Student Test Sessions (In-Memory with TTL)
---------------------------------------------------- */
const studentSessions = new Map(); // sessionToken -> sessionObject

function cleanExpiredSessions() {
  const now = Date.now();
  for (const [token, s] of studentSessions.entries()) {
    // Keep session around for max 12 hours after start
    if (now - s.startedAt > 12 * 60 * 60 * 1000) {
      studentSessions.delete(token);
    }
  }
}
setInterval(cleanExpiredSessions, 15 * 60 * 1000);

/* ----------------------------------------------------
   Teacher API: Sync & Register Assignments
---------------------------------------------------- */
app.post('/api/teacher/assignments', async (req, res) => {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Yêu cầu Bearer token xác thực của giáo viên.' });
  }

  const idToken = authHeader.slice(7).trim();
  const authUser = await verifyFirebaseIdToken(idToken);
  if (!authUser || !authUser.uid) {
    return res.status(401).json({ error: 'Token không hợp lệ hoặc đã hết hạn.' });
  }

  const { assignment, exam, classInfo } = req.body || {};
  if (!assignment || !assignment.code || !exam || !Array.isArray(exam.qs)) {
    return res.status(400).json({ error: 'Dữ liệu bài giao hoặc đề thi không hợp lệ.' });
  }

  const code = String(assignment.code).trim().toUpperCase();
  const existing = assignments.get(code);

  const mergedRecord = {
    code,
    teacherUid: authUser.uid,
    teacherEmail: authUser.email,
    id: assignment.id || existing?.id,
    eid: assignment.eid || exam.id,
    title: (assignment.title || exam.title || '').trim(),
    cid: assignment.cid || '',
    set: {
      min: Math.max(1, Math.min(300, Math.round(Number(assignment.set?.min) || 45))),
      open: assignment.set?.open || '',
      close: assignment.set?.close || '',
      tries: String(assignment.set?.tries ?? '1'),
      scale: Number(assignment.set?.scale) === 100 ? 100 : 10,
      pass: Math.max(0, Math.min(100, Number(assignment.set?.pass) || 50)),
      show: assignment.set?.show === 'no' ? 'no' : 'yes'
    },
    subs: Array.isArray(existing?.subs) ? existing.subs : (Array.isArray(assignment.subs) ? assignment.subs : []),
    exam: {
      id: exam.id,
      title: exam.title || assignment.title,
      qs: exam.qs
    },
    classInfo: classInfo || existing?.classInfo || null,
    updatedAt: Date.now()
  };

  assignments.set(code, mergedRecord);
  saveAssignmentsToDisk();

  return res.json({
    success: true,
    code,
    link: `/lam-bai/${code}`
  });
});

app.post('/api/teacher/sync-all', async (req, res) => {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Yêu cầu Bearer token xác thực.' });
  }

  const idToken = authHeader.slice(7).trim();
  const authUser = await verifyFirebaseIdToken(idToken);
  if (!authUser || !authUser.uid) {
    return res.status(401).json({ error: 'Token không hợp lệ.' });
  }

  const { assignments: asgList, exams, classes } = req.body || {};
  const examsMap = new Map((exams || []).map(e => [e.id, e]));
  const classesMap = new Map((classes || []).map(c => [c.id, c]));

  const submissionsByCode = {};

  if (Array.isArray(asgList)) {
    for (const a of asgList) {
      if (!a || !a.code) continue;
      const code = String(a.code).trim().toUpperCase();
      const existing = assignments.get(code);
      const e = examsMap.get(a.eid) || existing?.exam;
      const c = classesMap.get(a.cid) || existing?.classInfo;

      if (e && Array.isArray(e.qs)) {
        const existingSubs = existing?.subs || [];
        const clientSubs = Array.isArray(a.subs) ? a.subs : [];
        
        // Merge submissions avoiding duplicates by id or (name + at)
        const subMap = new Map();
        for (const s of clientSubs) {
          const key = s.id || `${s.name}_${s.at}`;
          subMap.set(key, s);
        }
        for (const s of existingSubs) {
          const key = s.id || `${s.name}_${s.at}`;
          subMap.set(key, s);
        }

        const mergedSubs = Array.from(subMap.values());

        assignments.set(code, {
          code,
          teacherUid: authUser.uid,
          teacherEmail: authUser.email,
          id: a.id,
          eid: a.eid,
          title: (a.title || e.title || '').trim(),
          cid: a.cid || '',
          set: {
            min: Math.max(1, Math.min(300, Math.round(Number(a.set?.min) || 45))),
            open: a.set?.open || '',
            close: a.set?.close || '',
            tries: String(a.set?.tries ?? '1'),
            scale: Number(a.set?.scale) === 100 ? 100 : 10,
            pass: Math.max(0, Math.min(100, Number(a.set?.pass) || 50)),
            show: a.set?.show === 'no' ? 'no' : 'yes'
          },
          subs: mergedSubs,
          exam: {
            id: e.id,
            title: e.title,
            qs: e.qs
          },
          classInfo: c ? { id: c.id, name: c.n, students: c.st || [] } : null,
          updatedAt: Date.now()
        });

        submissionsByCode[code] = mergedSubs;
      } else if (existing) {
        submissionsByCode[code] = existing.subs || [];
      }
    }
    saveAssignmentsToDisk();
  }

  return res.json({
    success: true,
    submissionsByCode
  });
});

app.get('/api/teacher/assignments/:code/submissions', async (req, res) => {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Yêu cầu Bearer token xác thực.' });
  }

  const idToken = authHeader.slice(7).trim();
  const authUser = await verifyFirebaseIdToken(idToken);
  if (!authUser || !authUser.uid) {
    return res.status(401).json({ error: 'Token không hợp lệ.' });
  }

  const code = String(req.params.code || '').trim().toUpperCase();
  const record = assignments.get(code);
  if (!record) {
    return res.status(404).json({ error: 'Không tìm thấy bài giao.' });
  }

  // Verify ownership
  if (record.teacherUid && record.teacherUid !== authUser.uid) {
    return res.status(403).json({ error: 'Bạn không có quyền xem bài giao của giáo viên khác.' });
  }

  return res.json({
    code,
    title: record.title,
    subs: record.subs || []
  });
});

/* ----------------------------------------------------
   Student API: Public Endpoints (No Auth Required)
   Subject to 30 req/min IP Rate Limiting
---------------------------------------------------- */

// 1. Get Exam Metadata (Sanitized: NO questions, NO answers)
app.get('/api/bai/:code/thong-tin', (req, res) => {
  const rateLimit = checkStudentRateLimit(req);
  if (!rateLimit.allowed) {
    return res.status(429).json({ error: rateLimit.reason });
  }

  const code = String(req.params.code || '').trim().toUpperCase();
  const record = assignments.get(code);
  if (!record || !record.exam || !Array.isArray(record.exam.qs)) {
    return res.status(404).json({
      error: `Không tìm thấy bài thi với mã "${code}". Vui lòng kiểm tra lại liên kết do giáo viên cung cấp.`
    });
  }

  const now = Date.now();
  const openTime = record.set.open ? new Date(record.set.open).getTime() : null;
  const closeTime = record.set.close ? new Date(record.set.close).getTime() : null;

  let status = 'open';
  let statusText = 'Bài thi đang mở làm bài.';

  if (openTime && now < openTime) {
    status = 'not_open';
    const openDateStr = new Date(openTime).toLocaleString('vi-VN');
    statusText = `Bài thi chưa đến thời gian mở (Mở lúc: ${openDateStr}).`;
  } else if (closeTime && now > closeTime) {
    status = 'closed';
    const closeDateStr = new Date(closeTime).toLocaleString('vi-VN');
    statusText = `Bài thi đã đóng lúc ${closeDateStr}.`;
  }

  return res.json({
    code: record.code,
    title: record.title,
    min: record.set.min,
    scale: record.set.scale,
    pass: record.set.pass,
    tries: record.set.tries,
    open: record.set.open || null,
    close: record.set.close || null,
    totalQuestions: record.exam.qs.length,
    status,
    statusText,
    className: record.classInfo?.name || '',
    students: (record.classInfo?.students || []).map(s => ({
      name: s.name,
      code: s.code || ''
    }))
  });
});

// 2. Start Exam Session (Returns Sanitized Questions WITHOUT answers or explanations)
app.post('/api/bai/:code/bat-dau', (req, res) => {
  const rateLimit = checkStudentRateLimit(req);
  if (!rateLimit.allowed) {
    return res.status(429).json({ error: rateLimit.reason });
  }

  const code = String(req.params.code || '').trim().toUpperCase();
  const record = assignments.get(code);
  if (!record || !record.exam || !Array.isArray(record.exam.qs)) {
    return res.status(404).json({ error: 'Bài thi không tồn tại hoặc đã bị gỡ.' });
  }

  // Timing check
  const now = Date.now();
  if (record.set.open && now < new Date(record.set.open).getTime()) {
    const openStr = new Date(record.set.open).toLocaleString('vi-VN');
    return res.status(403).json({ error: `Bài thi chưa mở. Thời gian mở: ${openStr}` });
  }
  if (record.set.close && now > new Date(record.set.close).getTime()) {
    const closeStr = new Date(record.set.close).toLocaleString('vi-VN');
    return res.status(403).json({ error: `Bài thi đã đóng lúc: ${closeStr}` });
  }

  const { name, className, studentCode } = req.body || {};
  const studentName = String(name || '').trim();
  if (!studentName) {
    return res.status(400).json({ error: 'Vui lòng nhập họ và tên của học sinh.' });
  }

  // Check maximum attempts
  const maxTries = parseInt(record.set.tries, 10);
  if (!isNaN(maxTries) && maxTries > 0) {
    const normName = studentName.toLowerCase();
    const normCode = String(studentCode || '').trim().toLowerCase();

    const previousAttempts = (record.subs || []).filter(s => {
      const sName = String(s.name || '').toLowerCase();
      const sCode = String(s.studentCode || '').toLowerCase();
      if (normCode && sCode && normCode === sCode) return true;
      return sName === normName;
    });

    if (previousAttempts.length >= maxTries) {
      return res.status(403).json({
        error: `Bạn đã thực hiện ${previousAttempts.length}/${maxTries} lần làm bài tối đa. Không thể làm thêm.`
      });
    }
  }

  // Create session
  const sessionToken = 'tok_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
  const durationMs = record.set.min * 60 * 1000;

  const session = {
    sessionToken,
    code,
    name: studentName,
    className: String(className || '').trim(),
    studentCode: String(studentCode || '').trim(),
    ip: rateLimit.ip,
    startedAt: now,
    durationMs,
    submitted: false
  };

  studentSessions.set(sessionToken, session);

  // SANITIZE QUESTIONS: Completely strip correct answers ('a', 'cor', 'c') and explanations ('exp', 'expl')
  const sanitizedQuestions = record.exam.qs.map((q, idx) => {
    const cleanQ = {
      n: idx + 1,
      q: q.q,
      o: Array.isArray(q.o) ? [...q.o] : []
    };
    if (q.p) cleanQ.p = q.p;
    if (q.type) cleanQ.type = q.type;
    if (q.leaflet) cleanQ.leaflet = q.leaflet;
    if (q.ad) cleanQ.ad = q.ad;
    return cleanQ;
  });

  return res.json({
    sessionToken,
    title: record.title,
    min: record.set.min,
    scale: record.set.scale,
    pass: record.set.pass,
    name: studentName,
    className: session.className,
    questions: sanitizedQuestions,
    startedAt: now,
    serverNow: now,
    expiresAt: now + durationMs
  });
});

// 3. Submit Exam (Server grades, checks timer, enforces result visibility)
app.post('/api/bai/:code/nop', (req, res) => {
  const rateLimit = checkStudentRateLimit(req);
  if (!rateLimit.allowed) {
    return res.status(429).json({ error: rateLimit.reason });
  }

  const code = String(req.params.code || '').trim().toUpperCase();
  const record = assignments.get(code);
  if (!record || !record.exam || !Array.isArray(record.exam.qs)) {
    return res.status(404).json({ error: 'Bài thi không tồn tại.' });
  }

  const { sessionToken, answers } = req.body || {};
  if (!sessionToken) {
    return res.status(400).json({ error: 'Thiếu mã phiên làm bài (sessionToken).' });
  }

  const session = studentSessions.get(sessionToken);
  if (!session || session.code !== code) {
    return res.status(400).json({ error: 'Phiên làm bài không hợp lệ hoặc đã hết hạn.' });
  }

  if (session.submitted) {
    return res.status(400).json({ error: 'Bài làm này đã được nộp trước đó.' });
  }

  // Calculate elapsed time strictly based on server clock
  const now = Date.now();
  const elapsedMs = Math.max(0, now - session.startedAt);
  const usedMs = Math.min(elapsedMs, session.durationMs);

  // Server-authoritative grading against real exam questions
  const total = record.exam.qs.length;
  const userAnswers = Array.isArray(answers) ? answers : [];
  let cor = 0;

  const reviewItems = record.exam.qs.map((q, idx) => {
    const userAns = (userAnswers[idx] !== undefined && userAnswers[idx] !== null) ? Number(userAnswers[idx]) : null;
    const isCorrect = (userAns !== null && userAns === q.a);
    if (isCorrect) cor++;
    return {
      n: idx + 1,
      userAns,
      corAns: q.a,
      isCorrect,
      exp: q.exp || q.expl || ''
    };
  });

  const scale = Number(record.set.scale) === 100 ? 100 : 10;
  const rawScore = total > 0 ? (cor / total) * scale : 0;
  const score = scale === 100 ? Math.round(rawScore) : Math.round(rawScore * 10) / 10;
  const passThreshold = Number(record.set.pass) || 50;
  const passed = total > 0 ? ((cor / total) * 100) >= passThreshold : false;

  // Record submission
  const subRecord = {
    id: 'sub_' + now + '_' + Math.random().toString(36).slice(2, 8),
    name: session.name,
    className: session.className,
    studentCode: session.studentCode,
    sc: score,
    cor,
    n: total,
    scale,
    passed,
    used: usedMs,
    at: now,
    ans: userAnswers
  };

  record.subs = record.subs || [];
  record.subs.push(subRecord);
  saveAssignmentsToDisk();

  // Mark session as completed
  session.submitted = true;

  // Enforce visibility of results based on teacher's settings
  const showAnswers = record.set.show !== 'no';

  if (!showAnswers) {
    return res.json({
      success: true,
      message: 'Đã nộp bài thành công!',
      showAnswers: false,
      name: session.name,
      className: session.className,
      used: usedMs,
      total
    });
  }

  return res.json({
    success: true,
    message: 'Đã nộp bài thành công!',
    showAnswers: true,
    name: session.name,
    className: session.className,
    score,
    scale,
    cor,
    total,
    passed,
    used: usedMs,
    questions: record.exam.qs, // Returned ONLY after grading and ONLY if permitted
    answers: userAnswers,
    reviewItems
  });
});

/* ----------------------------------------------------
   Student Direct URL Routes
---------------------------------------------------- */
app.get('/lam-bai/:code', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/lam-bai', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Fallback all other routes to index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(port, '0.0.0.0', () => {
  const rawKey = (process.env.GEMINI_API_KEY || '').trim();
  const keyLen = rawKey.length;
  const maskedKey = keyLen > 8 ? `${rawKey.slice(0, 4)}...${rawKey.slice(-4)}` : (keyLen > 0 ? '****' : '(chưa có)');
  console.log(`B-Lingo running on http://0.0.0.0:${port}`);
  console.log(`[Khởi động máy chủ] GEMINI_API_KEY: đã nạp = ${keyLen > 0}, độ dài = ${keyLen}, mã bảo mật = ${maskedKey}`);
  console.log(`[Khởi động máy chủ] GEMINI_MODEL: ${process.env.GEMINI_MODEL || 'gemini-3.8-flash (mặc định)'}`);
});
