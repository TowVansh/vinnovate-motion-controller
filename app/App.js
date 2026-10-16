// Tilt Pad: native phone controller (React Native + Expo) for the Tilt Maze browser game.
// Pair by scanning the game's QR code (or typing server + code), then tilt to steer, shake or tap JUMP to hop.
import { useEffect, useRef, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View, TextInput, Pressable, Vibration, KeyboardAvoidingView, Platform, PanResponder, Linking } from 'react-native';
import { DeviceMotion } from 'expo-sensors';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useKeepAwake } from 'expo-keep-awake';
import AsyncStorage from '@react-native-async-storage/async-storage';

const MAX_TILT = 12; // degrees of tilt for full speed
const SHAKE = 14;    // m/s^2 of linear acceleration that counts as a shake (jump)
const clamp = v => Math.max(-1, Math.min(1, v));
const toDeg = v => (Math.abs(v) > 2 * Math.PI ? v : (v * 180) / Math.PI); // rotation comes in radians on native

// The QR holds the game's pad link: https://host/pad.html?room=CODE&ws=ws://lan-ip:port
// Parsed by hand: React Native's URL/searchParams support is incomplete, so new URL() is not reliable on the phone.
export function parsePairing(text) {
  const m = /^(https?):\/\/([^/?#]+)[^?#]*\?([^#]*)/i.exec(String(text).trim());
  if (!m) return null;
  const params = {};
  for (const kv of m[3].split('&')) {
    const i = kv.indexOf('=');
    if (i > 0) params[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1).replace(/\+/g, ' '));
  }
  const room = (params.room || '').toUpperCase();
  const ws = params.ws || `${m[1].toLowerCase() === 'https' ? 'wss' : 'ws'}://${m[2]}`;
  return /^[A-Z]{4}$/.test(room) ? { room, ws } : null;
}
const wsFromServer = s => (/^wss?:\/\//.test(s) ? s : `ws://${s.trim()}`);

export default function App() {
  const [screen, setScreen] = useState('start');
  const [name, setName] = useState('');
  const [server, setServer] = useState('');
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [status, setStatus] = useState({ text: 'offline', color: '#f87171' });
  const [latency, setLatency] = useState(null);
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  const [count, setCount] = useState(null);
  const [result, setResult] = useState('');
  const [color, setColor] = useState('#facc15');

  const ws = useRef(null), retry = useRef(300), target = useRef(null), alive = useRef(false);
  const idRef = useRef(null), cal = useRef({ b: 0, g: 0 }), raw = useRef({ b: 0, g: 0 }), t = useRef({ x: 0, y: 0 });
  const linkSub = useRef(null);
  const rtt = useRef(null), lastShake = useRef(0), dragging = useRef(false);
  useKeepAwake();

  useEffect(() => { // restore saved name / id / calibration / last server
    (async () => {
      const [n, id, c, s] = await Promise.all(['name', 'id', 'cal', 'server'].map(k => AsyncStorage.getItem(k)));
      if (n) setName(n);
      if (s) setServer(s);
      if (c) cal.current = JSON.parse(c);
      idRef.current = id || Math.random().toString(36).slice(2, 12);
      if (!id) AsyncStorage.setItem('id', idRef.current);
      // opened from the game's QR link (phone camera -> https://tilt-maze.onrender.com/pad.html?room=...): join straight away
      const openLink = url => {
        const p = url && parsePairing(url);
        if (!p) return;
        setServer(p.ws); setCode(p.room);
        if (n) start(p, n); else setErr('Type your name, then tap START');
      };
      openLink(await Linking.getInitialURL());
      linkSub.current = Linking.addEventListener('url', ({ url }) => openLink(url));
    })();
    return () => linkSub.current && linkSub.current.remove();
  }, []);

  const send = m => ws.current && ws.current.readyState === 1 && ws.current.send(JSON.stringify(m));
  const vibrate = p => Vibration.vibrate(Array.isArray(p) ? [0, ...p] : p); // RN patterns start with a pause

  function connect() {
    const { url, room } = target.current;
    const sock = new WebSocket(url);
    ws.current = sock;
    setStatus({ text: 'connecting…', color: '#facc15' });
    sock.onopen = () => { retry.current = 300; sock.send(JSON.stringify({ t: 'join', code: room, id: idRef.current, name: target.current.who })); };
    sock.onclose = () => {
      if (!alive.current || ws.current !== sock) return;
      setStatus({ text: 'reconnecting…', color: '#f87171' });
      setTimeout(() => alive.current && ws.current === sock && connect(), retry.current);
      retry.current = Math.min(retry.current * 2, 4000);
    };
    sock.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.t === 'joined') { setColor(m.color); setScreen('pad'); setStatus(m.host ? { text: 'connected to game', color: '#4ade80' } : { text: 'waiting for game…', color: '#facc15' }); }
      else if (m.t === 'error') { alive.current = false; sock.close(); setErr(m.msg); setScreen('start'); }
      else if (m.t === 'host') setStatus(m.on ? { text: 'connected to game', color: '#4ade80' } : { text: 'game disconnected', color: '#f87171' });
      else if (m.t === 'pong') { rtt.current = Date.now() - m.ts; setLatency(Math.round(rtt.current / 2)); }
      else if (m.t === 'fx') {
        if (m.vibrate) vibrate(m.vibrate);
        if (m.count != null) { setCount(m.count || 'GO!'); setTimeout(() => setCount(c => (c === (m.count || 'GO!') ? null : c)), m.count ? 1100 : 600); }
      }
      else if (m.t === 'result') {
        setResult(`🏁 ${(m.ms / 1000).toFixed(2)}s · ${m.improved ? 'new personal best · ' : ''}#${m.rank} on the leaderboard`);
        setTimeout(() => setResult(''), 5000);
      }
    };
  }

  async function start(pairing, who = name) {
    setErr('');
    if (!who.trim()) return setErr('Type your name for the leaderboard');
    const p = pairing || (code.trim().length === 4 && server.trim() ? { room: code.trim().toUpperCase(), ws: wsFromServer(server) } : null);
    if (!p) return setErr('Scan the QR code on the laptop, or type the server address and the 4-letter code');
    AsyncStorage.multiSet([['name', who.trim()], ['server', p.ws]]);
    setServer(p.ws); setCode(p.room);
    target.current = { url: p.ws, room: p.room, who: who.trim() };
    alive.current = true;
    if (ws.current) { ws.current.onclose = null; ws.current.close(); }
    connect();
  }

  useEffect(() => { // motion sensors: tilt -> steering, linear acceleration spike -> jump
    let sub;
    (async () => {
      if (!(await DeviceMotion.isAvailableAsync())) return setErr('This phone has no motion sensor. Drag the dot instead.');
      if (!(await DeviceMotion.requestPermissionsAsync()).granted) return setErr('Motion permission denied. Drag the dot instead.');
      DeviceMotion.setUpdateInterval(16);
      sub = DeviceMotion.addListener(m => {
        if (m.rotation && !dragging.current) {
          raw.current = { b: toDeg(m.rotation.beta), g: toDeg(m.rotation.gamma) };
          t.current = { x: clamp((raw.current.g - cal.current.g) / MAX_TILT), y: clamp((raw.current.b - cal.current.b) / MAX_TILT) };
        }
        const a = m.acceleration;
        if (a && Math.hypot(a.x, a.y, a.z) > SHAKE && Date.now() - lastShake.current > 700) { lastShake.current = Date.now(); jump(); }
      });
    })();
    return () => sub && sub.remove();
  }, []);

  useEffect(() => { // stream at 60 Hz when tilt changes (+ keepalive), ping for latency, redraw dot at 30 Hz
    let sent = { x: 9, y: 9 }, last = 0, frame = 0;
    const iv = setInterval(() => {
      const x = +t.current.x.toFixed(3), y = +t.current.y.toFixed(3), now = Date.now();
      if (x !== sent.x || y !== sent.y || now - last > 250) { send({ t: 's', x, y, r: rtt.current == null ? null : Math.round(rtt.current) }); sent = { x, y }; last = now; }
      if (++frame % 2 === 0) setTilt({ x, y });
    }, 16);
    const ping = setInterval(() => send({ t: 'ping', ts: Date.now() }), 1000);
    return () => { clearInterval(iv); clearInterval(ping); };
  }, []);

  function jump() { send({ t: 'jump' }); Vibration.vibrate(30); }
  function calibrate() { cal.current = { ...raw.current }; AsyncStorage.setItem('cal', JSON.stringify(cal.current)); Vibration.vibrate(40); }
  function leave() { alive.current = false; if (ws.current) ws.current.close(); setScreen('start'); setStatus({ text: 'offline', color: '#f87171' }); }

  // touch fallback: drag inside the pad to steer
  const padSize = useRef({ w: 1, h: 1 });
  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderGrant: e => { dragging.current = true; dragTo(e.nativeEvent); },
    onPanResponderMove: e => dragTo(e.nativeEvent),
    onPanResponderRelease: () => { dragging.current = false; t.current = { x: 0, y: 0 }; },
  })).current;
  function dragTo({ locationX, locationY }) {
    t.current = { x: clamp((locationX / padSize.current.w - 0.5) * 2.4), y: clamp((locationY / padSize.current.h - 0.5) * 2.4) };
  }

  // Android: Google's system code scanner (Play Services) is far more reliable than an in-app camera analyzer.
  // Falls back to the in-app camera where it is not available (iOS, phones without Play Services).
  const scanSub = useRef(null);
  async function scanQr() {
    setErr('');
    if (!name.trim()) return setErr('Type your name for the leaderboard');
    if (Platform.OS !== 'android' || !CameraView.isModernBarcodeScannerAvailable) return setScreen('scan');
    if (scanSub.current) scanSub.current.remove();
    scanSub.current = CameraView.onModernBarcodeScanned(({ data }) => {
      scanSub.current && scanSub.current.remove(); scanSub.current = null;
      const p = parsePairing(data);
      if (p) start(p); else setErr(`That QR code is not a Tilt Maze game: ${String(data).slice(0, 80)}`);
    });
    try { await CameraView.launchScanner({ barcodeTypes: ['qr'] }); }
    catch (e) { setErr(`Google scanner unavailable (${e && e.message}). Opening the in-app camera.`); setScreen('scan'); }
  }

  if (screen === 'scan') return <Scanner onCancel={() => setScreen('start')} onCode={p => { setScreen('start'); start(p); }} />;

  if (screen === 'start') return (
    <KeyboardAvoidingView style={s.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <StatusBar style="light" />
      <Text style={s.h1}>Tilt Pad</Text>
      <Text style={s.muted}>Your phone becomes the controller for the Tilt Maze game on the laptop.</Text>
      <Text style={s.muted}>1. Type your name  2. Tap SCAN QR and point at the laptop  3. Tilt to roll your ball</Text>
      <Text style={s.label}>Your name (for the leaderboard)</Text>
      <TextInput style={s.input} value={name} onChangeText={setName} placeholder="Name" placeholderTextColor="#777" maxLength={16} />
      <Pressable style={[s.btn, s.primary]} onPress={scanQr}>
        <Text style={s.btnTextDark}>📷  SCAN QR TO START</Text>
      </Pressable>
      <Text style={s.muted}>Tip: you can also scan the laptop's QR code with your phone's normal camera app. It opens Tilt Pad and joins by itself.</Text>
      <Text style={[s.muted, { marginTop: 12 }]}>…or connect by hand</Text>
      <TextInput style={s.input} value={server} onChangeText={setServer} placeholder="Server, e.g. 192.168.137.1:5180" placeholderTextColor="#777" autoCapitalize="none" autoCorrect={false} />
      <TextInput style={[s.input, s.code]} value={code} onChangeText={v => setCode(v.toUpperCase())} placeholder="CODE" placeholderTextColor="#777" maxLength={4} autoCapitalize="characters" />
      <Pressable style={s.btn} onPress={() => start()}><Text style={s.btnText}>▶ START</Text></Pressable>
      {!!err && <Text style={s.err}>{err}</Text>}
    </KeyboardAvoidingView>
  );

  return (
    <View style={s.root}>
      <StatusBar style="light" />
      <View style={s.row}>
        <Text style={s.status}><Text style={{ color: status.color }}>● </Text>{status.text}</Text>
        <Text style={s.muted}>{latency == null ? '– ms' : `${latency} ms`}</Text>
      </View>
      <Text style={[s.muted, { textAlign: 'center' }]}>Tilt the phone to roll your ball · shake or press JUMP to hop over holes</Text>
      <View style={s.pad} {...pan.panHandlers} onLayout={e => (padSize.current = { w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
        <View style={s.crossV} /><View style={s.crossH} />
        <View style={[s.knob, { backgroundColor: color, left: `${50 + tilt.x * 42}%`, top: `${50 + tilt.y * 42}%` }]} />
        <Text style={s.padHint}>this dot shows your tilt · you can also drag it</Text>
        {count != null && <View style={s.count}><Text style={s.countText}>{count}</Text></View>}
      </View>
      <Text style={[s.muted, { textAlign: 'center', minHeight: 20 }]}>{result || `tilt ${tilt.x.toFixed(2)}, ${tilt.y.toFixed(2)}`}</Text>
      <View style={s.row}>
        <Pressable style={[s.btn, { flex: 1 }]} onPress={calibrate}><Text style={s.btnText}>Set level</Text><Text style={s.small}>hold still, tap</Text></Pressable>
        <Pressable style={[s.btn, s.primary, { flex: 1.4 }]} onPressIn={jump}><Text style={[s.btnTextDark, { fontSize: 26 }]}>JUMP</Text></Pressable>
      </View>
      <Pressable onPress={leave}><Text style={[s.muted, { textAlign: 'center', padding: 8 }]}>Leave game</Text></Pressable>
    </View>
  );
}

function Scanner({ onCode, onCancel }) {
  const [perm, requestPerm] = useCameraPermissions();
  const done = useRef(false);
  const [msg, setMsg] = useState('Point at the QR code on the laptop screen');
  if (!perm) return <View style={s.root} />;
  if (!perm.granted) return (
    <View style={[s.root, { justifyContent: 'center' }]}>
      <Text style={s.muted}>The camera is only used to read the game's QR code.</Text>
      <Pressable style={[s.btn, s.primary]} onPress={requestPerm}><Text style={s.btnTextDark}>Allow camera</Text></Pressable>
      <Pressable style={s.btn} onPress={onCancel}><Text style={s.btnText}>Back</Text></Pressable>
    </View>
  );
  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <CameraView style={{ flex: 1 }} barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={({ data }) => {
          if (done.current) return;
          const p = parsePairing(data);
          if (!p) return setMsg(`That QR code is not a Tilt Maze game:\n${String(data).slice(0, 80)}`);
          done.current = true; onCode(p);
        }} />
      <View style={s.scanBar}>
        <Text style={[s.muted, { color: '#fff' }]}>{msg}</Text>
        <Pressable style={s.btn} onPress={onCancel}><Text style={s.btnText}>Cancel</Text></Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#14120f', padding: 20, paddingTop: 56, gap: 12 },
  h1: { color: '#f3efe7', fontSize: 36, fontWeight: '800' },
  muted: { color: '#a39d92', fontSize: 14 },
  label: { color: '#a39d92', fontSize: 13, marginTop: 6 },
  input: { backgroundColor: '#fff', borderRadius: 10, padding: 12, fontSize: 18, color: '#111' },
  code: { fontSize: 26, letterSpacing: 6, textAlign: 'center', fontWeight: '700' },
  btn: { backgroundColor: '#3a352e', borderRadius: 12, padding: 16, alignItems: 'center', justifyContent: 'center' },
  primary: { backgroundColor: '#facc15' },
  btnText: { color: '#f3efe7', fontSize: 18, fontWeight: '700' },
  btnTextDark: { color: '#111', fontSize: 20, fontWeight: '800' },
  small: { color: '#a39d92', fontSize: 12 },
  err: { color: '#f87171', fontSize: 15 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 },
  status: { color: '#f3efe7', fontSize: 16 },
  pad: { flex: 1, backgroundColor: '#1f1c18', borderRadius: 16, overflow: 'hidden' },
  crossV: { position: 'absolute', left: '50%', top: 0, bottom: 0, width: 2, backgroundColor: '#ffffff14' },
  crossH: { position: 'absolute', top: '50%', left: 0, right: 0, height: 2, backgroundColor: '#ffffff14' },
  knob: { position: 'absolute', width: 56, height: 56, borderRadius: 28, marginLeft: -28, marginTop: -28, borderWidth: 6, borderColor: '#0004' },
  padHint: { position: 'absolute', bottom: 8, width: '100%', textAlign: 'center', color: '#a39d92', fontSize: 12 },
  count: { ...StyleSheet.absoluteFillObject, backgroundColor: '#0008', alignItems: 'center', justifyContent: 'center' },
  countText: { color: '#fff', fontSize: 120, fontWeight: '800' },
  scanBar: { position: 'absolute', bottom: 0, left: 0, right: 0, padding: 20, gap: 10, backgroundColor: '#000a' },
});
