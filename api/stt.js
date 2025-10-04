// api/stt.js — Vercel Serverless Function (Other preset)
// GET /api/stt?yt=<YouTubeID>&lang=pt
import fetch from 'node-fetch';
import ytdl from 'ytdl-core';
import FormData from 'form-data';

export const config = { api: { bodyParser: false, maxDuration: 60 } };

export default async function handler(req, res) {
  try {
    const { yt, lang = 'pt' } = req.query || {};
    if (!yt) return send(res, 400, { ok:false, error:'missing yt' });

    // 1) Pega melhor áudio (rápido e estável)
    // DICA de velocidade: force itag 140 (m4a ~128kbps)
    const info = await ytdl.getInfo(`https://www.youtube.com/watch?v=${yt}`);
    const format = info.formats.find(f => String(f.itag) === '140') ||
                   ytdl.chooseFormat(info.formats, { quality: 'highestaudio' });
    if (!format?.url) return send(res, 404, { ok:false, error:'no_audio_format' });

    // 2) Baixa áudio com limites pra ser ágil
    const maxBytes = 25 * 1024 * 1024; // 25MB
    const audioResp = await fetch(format.url, { headers: { 'user-agent':'Mozilla/5.0' }});
    if (!audioResp.ok) return send(res, 502, { ok:false, error:'audio_fetch_failed', status: audioResp.status });

    const reader = audioResp.body.getReader();
    const chunks = []; let received = 0; const t0 = Date.now();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > maxBytes) return send(res, 413, { ok:false, error:'audio_too_large', limitMB:25 });
      if ((Date.now()-t0)/1000 > 45) return send(res, 504, { ok:false, error:'download_timeout' });
      chunks.push(value);
    }
    const audioBuf = Buffer.concat(chunks);

    // 3) Transcreve com Whisper (OpenAI)
    if (!process.env.OPENAI_API_KEY) return send(res, 500, { ok:false, error:'missing OPENAI_API_KEY' });
    const form = new FormData();
    form.append('file', audioBuf, { filename: `${yt}.m4a`, contentType: 'audio/mp4' });
    form.append('model', 'whisper-1');
    form.append('language', lang);
    form.append('response_format', 'verbose_json');

    const stt = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form
    });
    if (!stt.ok) {
      const details = await stt.text().catch(()=> '');
      return send(res, 502, { ok:false, error:'whisper_failed', status: stt.status, details: details.slice(0,600) });
    }

    const data = await stt.json();
    const segments = (data.segments||[]).map(s=>({ start:s.start, end:s.end, text:(s.text||'').trim() }));
    const text = segments.map(s=>s.text).join(' ').trim();
    const vtt = toVTT(segments);
    return send(res, 200, { ok:true, text, segments, vtt });
  } catch (e) {
    return send(res, 500, { ok:false, error:'server_error', details: String(e).slice(0,600) });
  }
}

function send(res, status, obj){
  res.status(status)
     .set({
       'content-type':'application/json; charset=utf-8',
       'cache-control':'no-store',
       'access-control-allow-origin':'*',
       'access-control-allow-headers':'authorization,content-type',
       'access-control-allow-methods':'GET,POST,OPTIONS'
     }).send(JSON.stringify(obj));
}
function toVTT(segments){
  const ts = s=>{
    const h=Math.floor(s/3600), m=Math.floor((s%3600)/60), sec=Math.floor(s%60), ms=Math.floor((s-Math.floor(s))*1000);
    const pad=(n,z=2)=>String(n).padStart(z,'0');
    return `${pad(h)}:${pad(m)}:${pad(sec)}.${pad(ms,3)}`;
  };
  let out='WEBVTT\n\n';
  segments.forEach((seg,i)=>{ out += `${i+1}\n${ts(seg.start)} --> ${ts(seg.end)}\n${seg.text}\n\n`; });
  return out;
}
