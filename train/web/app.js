/* ══════════════════════════════════════════════════
   学習ダッシュボード フロント（テンプレート）
   指標の定義は /api/config から受け取るので、
   ゲームごとにこのファイルを書き換える必要はない。
   ══════════════════════════════════════════════════ */
(function () {
    'use strict';

    const $ = (id) => document.getElementById(id);
    const state = { config: null, status: {}, history: [], range: 0, logVersion: null };

    // ── 表示ヘルパー ──
    const fmt = {
        rate: (v) => (v === null || v === undefined) ? '—' : (v * 100).toFixed(1) + '%',
        float: (v) => (v === null || v === undefined) ? '—' : Number(v).toFixed(4),
        int: (v) => (v === null || v === undefined) ? '—' : Math.round(v).toLocaleString('ja-JP'),
    };
    const show = (m, v) => (fmt[m.fmt] || fmt.float)(v);
    const esc = (s) => String(s).replace(/[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    async function getJSON(url) {
        const res = await fetch(url);
        if (!res.ok) throw new Error(url + ' → ' + res.status);
        return res.json();
    }

    async function post(url, body) {
        const res = await fetch(url, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body || {}),
        });
        return res.json();
    }

    // ── 進捗タブ ──
    function tile(label, value, unit, sub) {
        return '<div class="tile"><div class="tile-label">' + esc(label) + '</div>'
            + '<div class="tile-value">' + value
            + (unit ? '<span class="unit">' + esc(unit) + '</span>' : '') + '</div>'
            + (sub ? '<div class="tile-sub">' + sub + '</div>' : '') + '</div>';
    }

    function renderProgress() {
        const st = state.status, recs = state.history;
        const latest = recs.length ? recs[recs.length - 1] : (st.latest || null);
        // 学習中は「いま回している世代」を出す。停止すると最後に完了した世代に戻る。
        const live = st.is_running ? st.live : null;
        const doneGen = latest ? latest.episode : 0;
        const showGen = (live && live.episode) ? live.episode : doneGen;

        const tiles = [
            tile('現在の世代', showGen, '',
                (live && live.episode) ? '学習中（完了済み ' + doneGen + ' 世代）' : ''),
            live
                ? tile('進行中のステップ', live.step + ' / ' + live.max_steps, '',
                    (live.phase === 'pretest' ? '起動前チェック中' : '自己対戦中')
                    + '<span class="step-bar"><span class="step-bar-fill" style="width:'
                    + (live.step / live.max_steps * 100).toFixed(1) + '%"></span></span>')
                : tile('進行中のステップ', '—', '', st.is_running ? '学習の準備中' : '世代の合間'),
            tile('ペース', st.pace_sec ? st.pace_sec.toFixed(1) : '—',
                st.pace_sec ? '秒/世代' : '',
                st.pace_sec ? '約 ' + (60 / st.pace_sec).toFixed(1) + ' 世代/分' : '直近の実測なし'),
        ];
        // 指標のタイルは設定から自動生成する
        state.config.metrics.forEach(function (m) {
            const found = lastDefined(recs, m.key);
            tiles.push(tile(m.label, found ? show(m, found[m.key]) : '—', '',
                found ? '第 ' + found.episode + ' 世代' : '未測定'));
        });
        $('progressTiles').innerHTML = tiles.join('');

        $('progressNote').textContent = st.is_running ? (st.mode || '学習中')
            : (recs.length ? '待機中（記録済み ' + recs.length + ' 世代）' : '待機中');
        $('statusText').textContent = st.is_running ? '学習中' : '待機中';
        $('statusDot').className = 'status-dot' + (st.is_running ? ' running' : '');
        $('statusGen').textContent = showGen ? '第 ' + showGen + ' 世代' : '';
        $('startBtn').disabled = !!st.is_running;
        $('stopBtn').disabled = !st.is_running;

        $('logView').innerHTML = (st.logs || []).map(function (l) {
            return '<div class="log-line ' + esc(l.tag) + '"><span class="log-time">'
                + esc(l.time) + '</span>' + esc(l.text) + '</div>';
        }).join('');
    }

    /** その指標が最後に記録された世代を返す（評価がまばらでも拾える） */
    function lastDefined(records, key) {
        for (let i = records.length - 1; i >= 0; i--) {
            const v = records[i][key];
            if (v !== null && v !== undefined) return records[i];
        }
        return null;
    }

    function renderTable() {
        const metrics = state.config.metrics;
        $('genHead').innerHTML = '<th>世代</th>'
            + metrics.map((m) => '<th class="num">' + esc(m.label) + '</th>').join('');
        const rows = state.history.slice().reverse().slice(0, 500);
        $('genTableBody').innerHTML = rows.length
            ? rows.map(function (r) {
                return '<tr><td>' + r.episode + '</td>'
                    + metrics.map((m) => '<td class="num">' + show(m, r[m.key]) + '</td>').join('')
                    + '</tr>';
            }).join('')
            : '<tr><td colspan="' + (metrics.length + 1) + '" class="empty">'
              + 'まだ世代の記録がありません</td></tr>';
        $('genCountNote').textContent = state.history.length + ' 世代を記録中';
    }

    // ── グラフタブ ──
    function renderCharts() {
        const recs = state.range > 0 ? state.history.slice(-state.range) : state.history;
        const xMin = recs.length ? recs[0].episode : undefined;
        const xMax = recs.length ? recs[recs.length - 1].episode : undefined;

        // 指標ごとに1枚。単位の違うものを1つのグラフに混ぜない（2軸は作らない）
        $('chartCards').innerHTML = state.config.metrics.map(function (m, i) {
            return '<div class="card"><div class="card-head"><div class="card-title">'
                + esc(m.label) + '</div></div><div class="chart-box" id="chart' + i + '"></div></div>';
        }).join('');

        state.config.metrics.forEach(function (m, i) {
            const scale = m.fmt === 'rate' ? 100 : 1;
            const points = recs.map(function (r) {
                const v = r[m.key];
                return { x: r.episode, y: (v === null || v === undefined) ? null : v * scale };
            });
            const axis = m.fmt === 'rate'
                ? { label: '%', min: 0, max: 100, format: (v) => v.toFixed(0) + '%' }
                : { label: '', format: (v) => Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(3) };
            MDDChart.render($('chart' + i), {
                height: 240, xLabel: '世代', xMin: xMin, xMax: xMax,
                series: [{ key: m.key, label: m.label, points: points,
                           tipFormat: (v) => m.fmt === 'rate' ? v.toFixed(1) + '%' : v.toFixed(4) }],
                axes: { left: axis },
                emptyText: 'まだ記録がありません。',
            });
        });
    }

    // ── 通信 ──
    async function loadHistory() {
        const data = await getJSON('/api/history');
        state.history = data.records || [];
        renderProgress();
        renderTable();
        renderCharts();
    }

    function applyStatus(st) {
        state.status = st;
        renderProgress();
        // ログが変わったときだけ取り直す（毎回は取らない）
        if (st.log_version !== state.logVersion) {
            state.logVersion = st.log_version;
            loadHistory();
        }
    }

    function connect() {
        try {
            const es = new EventSource('/api/stream');
            es.onmessage = (ev) => applyStatus(JSON.parse(ev.data));
            es.onerror = () => { es.close(); setTimeout(connect, 3000); };
        } catch (e) {
            setInterval(async () => applyStatus(await getJSON('/api/status')), 2000);
        }
    }

    // ── 起動 ──
    async function init() {
        state.config = await getJSON('/api/config');
        document.title = state.config.title;
        $('appTitle').textContent = state.config.title;
        $('modeSelect').innerHTML = state.config.modes
            .map((m) => '<option value="' + esc(m) + '">' + esc(m) + '</option>').join('');

        document.querySelectorAll('#tabbar button').forEach(function (btn) {
            btn.addEventListener('click', function () {
                document.querySelectorAll('#tabbar button').forEach((b) => b.classList.remove('active'));
                document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
                btn.classList.add('active');
                $('view-' + btn.dataset.tab).classList.add('active');
                if (btn.dataset.tab === 'charts') renderCharts();
            });
        });
        document.querySelectorAll('#rangeButtons button').forEach(function (btn) {
            btn.addEventListener('click', function () {
                document.querySelectorAll('#rangeButtons button').forEach((b) => b.classList.remove('active'));
                btn.classList.add('active');
                state.range = parseInt(btn.dataset.range, 10);
                renderCharts();
            });
        });
        const openPanel = (on) => {
            $('settingsPanel').classList.toggle('open', on);
            $('settingsOverlay').classList.toggle('show', on);
        };
        $('settingsBtn').addEventListener('click', () => openPanel(true));
        $('settingsClose').addEventListener('click', () => openPanel(false));
        $('settingsOverlay').addEventListener('click', () => openPanel(false));

        $('startBtn').addEventListener('click', async function () {
            const res = await post('/api/start', {
                mode: $('modeSelect').value,
                gens: parseInt($('gensInput').value, 10) || 20,
                num_envs: parseInt($('envsInput').value, 10) || 0,
            });
            if (!res.ok) alert(res.message);
            openPanel(false);
        });
        $('stopBtn').addEventListener('click', async function () {
            if (!confirm('学習を停止しますか？')) return;
            const res = await post('/api/stop');
            if (!res.ok) alert(res.message);
        });

        await loadHistory();
        connect();
    }

    init().catch((e) => alert('起動に失敗しました: ' + e));
})();
