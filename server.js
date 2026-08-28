const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3001;

// ---- Typeform credentials ----
// Load from: (1) environment variables TYPEFORM_TOKEN
//            (2) typeform.config.json file (created from typeform.config.example.json)
// Config shape: { "token": "...", "forms": [ { "formId":"...", "campus":"...", "category":"...", "label":"..." } ] }
const loadTypeformConfig = () => {
    let fileConfig = {};
    try {
        const cfgPath = path.join(__dirname, 'typeform.config.json');
        if (fs.existsSync(cfgPath)) {
            fileConfig = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
        }
    } catch (e) {
        console.warn('[Typeform] Gagal membaca typeform.config.json:', e.message);
    }
    const token = process.env.TYPEFORM_TOKEN || fileConfig.token || '';
    let forms = Array.isArray(fileConfig.forms) ? fileConfig.forms : [];
    // Deployment-friendly: daftar form bisa lewat env TYPEFORM_FORMS (JSON array)
    // atau file typeform.forms.json yang ter-commit (tanpa token rahasia).
    if (process.env.TYPEFORM_FORMS) {
        try {
            forms = JSON.parse(process.env.TYPEFORM_FORMS);
            if (!Array.isArray(forms)) throw new Error('bukan array');
        } catch (e) {
            console.warn('[Typeform] Gagal parse TYPEFORM_FORMS:', e.message);
        }
    }
    if (forms.length === 0) {
        try {
            const formsPath = path.join(__dirname, 'typeform.forms.json');
            if (fs.existsSync(formsPath)) {
                const parsed = JSON.parse(fs.readFileSync(formsPath, 'utf-8'));
                if (Array.isArray(parsed)) forms = parsed;
            }
        } catch (e) {
            console.warn('[Typeform] Gagal membaca typeform.forms.json:', e.message);
        }
    }
    // Back-compat: legacy single-form config { formId: "..." }
    if (forms.length === 0 && fileConfig.formId) {
        forms = [{ formId: fileConfig.formId, campus: 'Regional Campus', category: '', label: 'Typeform' }];
    }
    return { token, forms };
};

const typeformConfigured = (cfg = null) => {
    const c = cfg || loadTypeformConfig();
    return !!(c.token && c.forms && c.forms.length > 0);
};

// ---- Typeform Responses API ----
// Fetch every configured form response using pagination. Runs all forms in
// parallel, then converts each to a CSV blob (mirroring Typeform's export) with
// Campus/Program/Batch prefilled so the frontend parser picks them up.
function fetchFormResponses(cfg, form) {
    const base = `https://api.typeform.com/forms/${encodeURIComponent(form.formId)}/responses`;

    const getPage = (params) => new Promise((resolve, reject) => {
        const url = `${base}?${new URLSearchParams(params).toString()}`;
        let body = '';
        const req = https.get(url, {
            headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/json' }
        }, (res) => {
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    reject(new Error(`[${form.formId}] Typeform API HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
                    return;
                }
                try { resolve(JSON.parse(body)); } catch (e) {
                    reject(new Error(`[${form.formId}] Respons bukan JSON valid.`));
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(60000, () => { req.destroy(new Error(`[${form.formId}] Timeout menghubungi Typeform API.`)); });
    });

    // Forward crawl using `since`/`until`. The `after` cursor is unreliable for
    // forms with >1000 responses, so we walk forward in time, advancing `since`
    // past the latest submission each full page, deduplicating by response_id.
    return new Promise((resolve, reject) => {
        (async () => {
            try {
                const allItems = [];
                const seen = new Set();
                let since = '2000-01-01T00:00:00Z';
                let guard = 0;

                while (guard++ < 500) {
                    const json = await getPage({
                        page_size: '1000',
                        sort: 'submitted_at,asc',
                        since,
                        completed: 'true'
                    });
                    const items = json.items || [];
                    for (const it of items) {
                        if (!seen.has(it.response_id)) { seen.add(it.response_id); allItems.push(it); }
                    }
                    if (items.length === 0) break;

                    const last = items[items.length - 1];
                    const lastTs = last.submitted_at;
                    if (lastTs && lastTs !== '0001-01-01T00:00:00Z') {
                        const d = new Date(lastTs);
                        d.setSeconds(d.getSeconds() + 1);
                        const next = d.toISOString().replace(/\.\d{3}Z$/, 'Z');
                        if (next === since) { d.setMinutes(d.getMinutes() + 1); since = d.toISOString().replace(/\.\d{3}Z$/, 'Z'); }
                        else { since = next; }
                    } else {
                        break;
                    }
                    if (items.length < 1000) break;
                }

                resolve(allItems);
            } catch (e) {
                reject(e);
            }
        })();
    });
}

// Fetch the form definition (fields with titles). Responses only expose field
// {id,type,ref}, so question titles must be resolved from the definition.
function fetchFormDefinition(cfg, form) {
    return new Promise((resolve, reject) => {
        const url = `https://api.typeform.com/forms/${encodeURIComponent(form.formId)}`;
        let body = '';
        const req = https.get(url, {
            headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/json' }
        }, (res) => {
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    reject(new Error(`[${form.formId}] Definisi form HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
                    return;
                }
                try { resolve(JSON.parse(body)); } catch (e) {
                    reject(new Error(`[${form.formId}] Definisi form bukan JSON valid.`));
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(30000, () => { req.destroy(new Error(`[${form.formId}] Timeout memuat definisi form.`)); });
    });
}

// Recursively flatten a form definition's fields into an id -> readable label map.
// Typeform responses only carry field {id,type,ref}, so question titles must come
// from the form definition (groups expose their children via properties.fields).
function buildFieldTitleMap(fields, map = new Map()) {
    for (const f of (fields || [])) {
        if (f && f.id) {
            const t = f.title ? String(f.title).replace(/<[^>]*>/g, '').trim() : '';
            if (t) map.set(f.id, t);
        }
        if (f && f.properties && Array.isArray(f.properties.fields)) {
            buildFieldTitleMap(f.properties.fields, map);
        }
    }
    return map;
}

// Derive the readable question text: prefer the provided field-title map, else
// the field.title if present, else the field id as a fallback.
function questionLabel(field, fieldTitles) {
    if (field && fieldTitles && field.id && fieldTitles.has(field.id)) {
        return fieldTitles.get(field.id);
    }
    const t = field && field.title ? String(field.title) : '';
    return (t || (field && field.id) || '').replace(/<[^>]*>/g, '').trim();
}

// Convert raw Typeform responses into a CSV string that mirrors Typeform's export.
// meta = { campus, program, batch } used to prefill the metadata columns.
// fieldTitles = Map(id -> readable question label) from the form definition.
function typeformToCSV(responses, meta = {}, fieldTitles = new Map()) {
    if (!responses || responses.length === 0) return '';
    const campus = meta.campus || 'Regional Campus';
    const program = meta.program || 'Peserta Pelatihan';
    const batch = meta.batch || '-';

    const headersSet = [];
    const headerIndex = new Map();

    const ensureHeader = (q) => {
        if (headerIndex.has(q)) return headerIndex.get(q);
        const idx = headersSet.length;
        headersSet.push(q);
        headerIndex.set(q, idx);
        return idx;
    };

    const convertValue = (answer, field) => {
        if (!answer) return '';
        const type = answer.type;
        if (type === 'text' || type === 'short_text' || type === 'long_text') return answer.text || '';
        if (type === 'number') return String(answer.number ?? '');
        if (type === 'boolean') return answer.boolean ? 'Ya' : 'Tidak';
        if (type === 'email') return answer.email || '';
        if (type === 'url') return answer.url || '';
        if (type === 'phone_number') return answer.phone_number || '';
        if (type === 'date') return answer.date || '';
        if (type === 'choice') return answer.choice ? answer.choice.label : '';
        if (type === 'choices') return (answer.choices && answer.choices.labels ? answer.choices.labels : []).join(', ');
        if (type === 'file_url') return answer.file_url || '';
        if (type === 'payment') return '';
        if (type === 'opinion_scale' && typeof answer.rating === 'number') return String(answer.rating);
        if (type === 'rating' && typeof answer.rating === 'number') return String(answer.rating);
        return '';
    };

    // First: build header/columns in order encountered, preserving the metadata columns
    // that the parser expects (response #, submit date, ...). Typeform data rows are
    // heterogeneous, so we collect question titles from every answer.
    for (const r of responses) {
        if (!r.answers) continue;
        for (const a of r.answers) {
            ensureHeader(questionLabel(a.field, fieldTitles));
        }
    }

    const prependMeta = [
        '#',
        'Response ID',
        'Submit Date',
        'Campus',
        'Program',
        'Batch'
    ];
    const metaHeaders = [...prependMeta, ...headersSet];
    const qIdx = new Map();
    prependMeta.forEach((h, i) => qIdx.set(h, i));
    headersSet.forEach((h, i) => qIdx.set(h, i + prependMeta.length));

    const escapeCSV = (v) => {
        const s = (v == null ? '' : String(v));
        if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
        return s;
    };

    const rowsOut = [metaHeaders];
    responses.forEach((r, i) => {
        const row = new Array(metaHeaders.length).fill('');
        row[qIdx.get('#')] = String(i + 1);
        row[qIdx.get('Response ID')] = r.response_id || `RESP-${i + 1}`;
        const ts = r.submitted_at || r.landed_at || '';
        row[qIdx.get('Submit Date')] = String(ts).split('T')[0];
        row[qIdx.get('Campus')] = campus;
        row[qIdx.get('Program')] = program;
        row[qIdx.get('Batch')] = batch;
        if (r.answers) {
            for (const a of r.answers) {
                const idx = qIdx.get(questionLabel(a.field, fieldTitles));
                if (idx !== undefined && idx >= prependMeta.length) {
                    row[idx] = convertValue(a, a.field);
                }
            }
        }
        rowsOut.push(row.map(escapeCSV).join(','));
    });

    return rowsOut.map(r => Array.isArray(r) ? r.map(escapeCSV).join(',') : r).join('\n');
}
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.csv': 'text/csv'
};

const server = http.createServer(async (req, res) => {
    let reqUrl = req.url.split('?')[0];

    const sendJSON = (status, obj) => {
        const body = JSON.stringify(obj);
        res.writeHead(status, {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*'
        });
        res.end(body);
    };

    // ---- Typeform API routes ----
    if (reqUrl === '/api/typeform/config') {
        const cfg = loadTypeformConfig();
        sendJSON(200, {
            configured: typeformConfigured(cfg),
            forms: cfg.forms.map(f => ({ formId: f.formId, campus: f.campus, category: f.category, label: f.label || f.formId }))
        });
        return;
    }

    if (reqUrl === '/api/typeform/responses') {
        const cfg = loadTypeformConfig();
        if (!typeformConfigured(cfg)) {
            sendJSON(400, { error: 'Typeform belum dikonfigurasi. Isi token & daftar form di typeform.config.json (lihat typeform.config.example.json) atau set env TYPEFORM_TOKEN.' });
            return;
        }
        try {
            // Fetch all forms in parallel; each form fails independently.
            const results = await Promise.allSettled(
                cfg.forms.map(async (form) => {
                    const [responses, definition] = await Promise.all([
                        fetchFormResponses(cfg, form),
                        fetchFormDefinition(cfg, form)
                    ]);
                    const fieldTitles = buildFieldTitleMap(definition && definition.fields);
                    const csv = typeformToCSV(responses, {
                        campus: form.campus,
                        program: form.label || form.formId,
                        batch: '-'
                    }, fieldTitles);
                    return { formId: form.formId, campus: form.campus, category: form.category, label: form.label || form.formId, csv, count: responses.length };
                })
            );

            const forms = [];
            let totalCount = 0;
            const errors = [];
            for (const r of results) {
                if (r.status === 'fulfilled' && r.value.count > 0) {
                    forms.push(r.value);
                    totalCount += r.value.count;
                } else if (r.status === 'rejected') {
                    errors.push(r.reason && r.reason.message || 'Unknown error');
                }
            }

            if (forms.length === 0) {
                sendJSON(200, { forms: [], totalCount: 0, errors });
                return;
            }
            sendJSON(200, { forms, totalCount, errors });
        } catch (err) {
            sendJSON(502, { error: `Gagal mengambil data Typeform: ${err.message}` });
        }
        return;
    }

    if (reqUrl === '/' || reqUrl === '') {
        reqUrl = '/Campus_Dashboard_Survey.html';
    }

    const filePath = path.join(__dirname, reqUrl);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, content) => {
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('404 Not Found');
            } else {
                res.writeHead(500);
                res.end(`Server Error: ${err.code}`);
            }
        } else {
            res.writeHead(200, {
                'Content-Type': contentType,
                'Access-Control-Allow-Origin': '*'
            });
            res.end(content, 'utf-8');
        }
    });
});

server.listen(PORT, () => {
    console.log(`\n======================================================`);
    console.log(`🚀 BRI Regional Campus Survey Dashboard is Running!`);
    console.log(`👉 Akses di Browser: http://localhost:${PORT}`);
    console.log(`======================================================\n`);
});
