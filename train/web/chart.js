/* ══════════════════════════════════════════════════════
   軽量SVG折れ線グラフ（外部ライブラリ非依存）
   凡例・軸ラベル・ホバー時の数値表示に対応。

   設計上の決めごと:
   - 縦軸は必ず1本。2軸グラフ（左右で別スケール）は、2つの目盛りの
     合わせ方が恣意的になり実在しない相関を見せてしまうため作らない。
     単位が違う指標は別々のグラフにする。
   - モノトーン配色なので、系列の区別は実線／破線で行う。3系列以上に
     なる場合は色を増やさず、小さなグラフを並べる（small multiples）。
   - グリッド線は実線のヘアライン（破線はノイズになり「しきい値」に見える）。
   ══════════════════════════════════════════════════════ */
(function (global) {
    'use strict';

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const INK = '#111111';
    const INK3 = '#8e8e8e';
    const LINE = '#e6e6e6';
    const AXIS = '#d2d2d2';

    function el(name, attrs) {
        const node = document.createElementNS(SVG_NS, name);
        for (const key in attrs) {
            if (attrs[key] !== undefined && attrs[key] !== null) {
                node.setAttribute(key, attrs[key]);
            }
        }
        return node;
    }

    /** 目盛りとして気持ちのよい間隔を選ぶ */
    function niceTicks(min, max, count) {
        if (!isFinite(min) || !isFinite(max)) return { ticks: [0, 1], min: 0, max: 1 };
        if (min === max) {
            const pad = Math.abs(min) > 1e-9 ? Math.abs(min) * 0.5 : 1;
            min -= pad; max += pad;
        }
        const rawStep = (max - min) / Math.max(1, count);
        const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
        const norm = rawStep / mag;
        const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
        const lo = Math.floor(min / step) * step;
        const hi = Math.ceil(max / step) * step;
        const ticks = [];
        for (let v = lo; v <= hi + step * 0.5; v += step) {
            ticks.push(Math.abs(v) < step * 1e-6 ? 0 : v);
        }
        return { ticks, min: lo, max: hi };
    }

    function defaultFormat(v) {
        const abs = Math.abs(v);
        if (abs >= 1000) return v.toFixed(0);
        if (abs >= 10) return v.toFixed(1);
        if (abs >= 1) return v.toFixed(2);
        if (abs === 0) return '0';
        return v.toFixed(4);
    }

    /**
     * @param {HTMLElement} container  .chart-box 相当の要素（position:relative）
     * @param {Object} config
     *   height     グラフ高さ(px)
     *   xLabel     X軸ラベル / xMin, xMax 表示範囲の下限・上限（省略可）
     *   series     [{ key, label, dash:bool, points:[{x,y}], tipFormat }]
     *   axes.left  { label, format, min, max }
     */
    function render(container, config) {
        const cfg = config || {};
        const series = (cfg.series || []).map(function (s) {
            return Object.assign({}, s, {
                points: (s.points || []).filter(function (p) {
                    return p && isFinite(p.x) && p.y !== null && p.y !== undefined && isFinite(p.y);
                }).sort(function (a, b) { return a.x - b.x; })
            });
        });

        container.innerHTML = '';
        const hasData = series.some(function (s) { return s.points.length > 0; });
        if (!hasData) {
            const empty = document.createElement('div');
            empty.className = 'placeholder';
            empty.textContent = cfg.emptyText || 'まだデータがありません。学習を開始すると描画されます。';
            container.appendChild(empty);
            return;
        }

        const height = cfg.height || 260;
        const width = Math.max(220, container.clientWidth || 640);

        // ── 縦スケール（1本だけ） ──
        const axisOpts = (cfg.axes && cfg.axes.left) || {};
        let lo = Infinity, hi = -Infinity;
        series.forEach(function (s) {
            s.points.forEach(function (p) {
                if (p.y < lo) lo = p.y;
                if (p.y > hi) hi = p.y;
            });
        });
        if (!isFinite(lo)) { lo = 0; hi = 1; }
        if (axisOpts.min !== undefined) lo = axisOpts.min;
        if (axisOpts.max !== undefined) hi = axisOpts.max;
        const scale = niceTicks(lo, hi, height < 200 ? 2 : 4);
        if (axisOpts.min !== undefined) scale.min = axisOpts.min;
        if (axisOpts.max !== undefined) scale.max = axisOpts.max;
        const format = axisOpts.format || defaultFormat;
        const axisLabel = axisOpts.label || '';

        // 目盛り文字の幅に合わせて左の余白を決める（小さなグラフで無駄に空けない）
        let tickChars = 0;
        scale.ticks.forEach(function (t) { tickChars = Math.max(tickChars, format(t).length); });
        const pad = {
            top: 12,
            right: 18,
            bottom: 30,
            left: Math.round(tickChars * 6.8) + 12 + (axisLabel ? 16 : 0),
        };
        const plotW = Math.max(40, width - pad.left - pad.right);
        const plotH = Math.max(40, height - pad.top - pad.bottom);

        // ── 横スケール ──
        let xMin = Infinity, xMax = -Infinity;
        series.forEach(function (s) {
            s.points.forEach(function (p) {
                if (p.x < xMin) xMin = p.x;
                if (p.x > xMax) xMax = p.x;
            });
        });
        // 系列が疎（評価は EVAL_EVERY 世代ごと）でも他のグラフと横軸を揃えられるように
        if (isFinite(cfg.xMin)) xMin = Math.min(xMin, cfg.xMin);
        if (isFinite(cfg.xMax)) xMax = Math.max(xMax, cfg.xMax);
        if (xMin === xMax) { xMin -= 1; xMax += 1; }

        const xOf = function (x) { return pad.left + (x - xMin) / (xMax - xMin) * plotW; };
        const yOf = function (y) {
            const span = (scale.max - scale.min) || 1;
            return pad.top + plotH - (y - scale.min) / span * plotH;
        };

        const svg = el('svg', { width: width, height: height, viewBox: '0 0 ' + width + ' ' + height });

        // ── 横グリッド＋目盛り（実線のヘアライン） ──
        scale.ticks.forEach(function (t) {
            if (t < scale.min - 1e-9 || t > scale.max + 1e-9) return;
            const y = yOf(t);
            svg.appendChild(el('line', {
                x1: pad.left, x2: pad.left + plotW, y1: y, y2: y,
                stroke: LINE, 'stroke-width': 1
            }));
            const label = el('text', {
                x: pad.left - 7, y: y + 4, 'text-anchor': 'end',
                'font-size': 11, fill: INK3
            });
            label.textContent = format(t);
            svg.appendChild(label);
        });

        // ── X軸目盛り（世代は整数。範囲が狭いときは重複しないよう間引く） ──
        let xTickCount = Math.max(2, Math.min(7, Math.floor(plotW / 90)));
        xTickCount = Math.max(1, Math.min(xTickCount, Math.round(xMax - xMin)));
        for (let i = 0; i <= xTickCount; i++) {
            const xv = xMin + (xMax - xMin) * (i / xTickCount);
            const x = xOf(xv);
            svg.appendChild(el('line', {
                x1: x, x2: x, y1: pad.top + plotH, y2: pad.top + plotH + 4,
                stroke: LINE, 'stroke-width': 1
            }));
            const label = el('text', {
                x: x, y: pad.top + plotH + 16, 'text-anchor': 'middle',
                'font-size': 11, fill: INK3
            });
            label.textContent = Math.round(xv);
            svg.appendChild(label);
        }

        svg.appendChild(el('line', {
            x1: pad.left, x2: pad.left + plotW, y1: pad.top + plotH, y2: pad.top + plotH,
            stroke: AXIS, 'stroke-width': 1
        }));

        // ── 軸ラベル ──
        if (cfg.xLabel && height >= 200) {
            const t = el('text', {
                x: pad.left + plotW / 2, y: height - 2, 'text-anchor': 'middle',
                'font-size': 11, fill: INK3
            });
            t.textContent = cfg.xLabel;
            svg.appendChild(t);
        }
        if (axisLabel) {
            const cy = pad.top + plotH / 2;
            const t = el('text', {
                x: 11, y: cy, 'text-anchor': 'middle', 'font-size': 11, fill: INK3,
                transform: 'rotate(-90 11 ' + cy + ')'
            });
            t.textContent = axisLabel;
            svg.appendChild(t);
        }

        // ── 折れ線（実線=主系列 / 破線=副系列） ──
        series.forEach(function (s) {
            if (!s.points.length) return;
            const d = s.points.map(function (p, i) {
                return (i === 0 ? 'M' : 'L') + xOf(p.x).toFixed(2) + ' ' + yOf(p.y).toFixed(2);
            }).join(' ');
            svg.appendChild(el('path', {
                d: d, fill: 'none',
                stroke: s.dash ? INK3 : INK,
                'stroke-width': 2,
                'stroke-dasharray': s.dash ? '5 4' : null,
                'stroke-linejoin': 'round', 'stroke-linecap': 'round'
            }));
            if (s.points.length === 1) {
                const p = s.points[0];
                svg.appendChild(el('circle', {
                    cx: xOf(p.x), cy: yOf(p.y), r: 4, fill: s.dash ? INK3 : INK
                }));
            }
        });

        // ── ホバー ──
        const guide = el('line', {
            x1: 0, x2: 0, y1: pad.top, y2: pad.top + plotH,
            stroke: INK3, 'stroke-width': 1, opacity: 0
        });
        svg.appendChild(guide);

        const markers = series.map(function (s) {
            // 白リング付きの4.5px半径（=9px）。重なっても見分けがつく。
            const c = el('circle', {
                r: 4.5, fill: s.dash ? INK3 : INK,
                stroke: '#ffffff', 'stroke-width': 2, opacity: 0
            });
            svg.appendChild(c);
            return c;
        });

        const overlay = el('rect', {
            x: pad.left, y: pad.top, width: plotW, height: plotH,
            fill: 'transparent', style: 'cursor:crosshair'
        });
        svg.appendChild(overlay);
        container.appendChild(svg);

        const tip = document.createElement('div');
        tip.className = 'chart-tip';
        container.appendChild(tip);

        const xValues = Array.from(new Set(
            series.reduce(function (acc, s) {
                return acc.concat(s.points.map(function (p) { return p.x; }));
            }, [])
        )).sort(function (a, b) { return a - b; });

        function nearestPoint(points, x) {
            let best = null, bestDist = Infinity;
            for (let i = 0; i < points.length; i++) {
                const dist = Math.abs(points[i].x - x);
                if (dist < bestDist) { bestDist = dist; best = points[i]; }
            }
            return best ? { point: best, dist: bestDist } : null;
        }

        function hide() {
            guide.setAttribute('opacity', 0);
            markers.forEach(function (m) { m.setAttribute('opacity', 0); });
            tip.style.display = 'none';
        }

        overlay.addEventListener('mousemove', function (ev) {
            const rect = svg.getBoundingClientRect();
            const ratio = (ev.clientX - rect.left - pad.left) / plotW;
            const xTarget = xMin + ratio * (xMax - xMin);

            let hoverX = xValues[0];
            let bestDist = Infinity;
            xValues.forEach(function (v) {
                const d = Math.abs(v - xTarget);
                if (d < bestDist) { bestDist = d; hoverX = v; }
            });

            const gx = xOf(hoverX);
            guide.setAttribute('x1', gx);
            guide.setAttribute('x2', gx);
            guide.setAttribute('opacity', 1);

            let html = '<div class="tip-head">' + (cfg.xLabel || '世代') + ' ' + Math.round(hoverX) + '</div>';
            let shown = 0;
            // 評価のように疎な系列も拾えるよう、少しだけ近傍を許容する
            const tolerance = Math.max(1, (xMax - xMin) * 0.03);
            series.forEach(function (s, i) {
                const near = nearestPoint(s.points, hoverX);
                if (!near || near.dist > tolerance) {
                    markers[i].setAttribute('opacity', 0);
                    return;
                }
                markers[i].setAttribute('cx', xOf(near.point.x));
                markers[i].setAttribute('cy', yOf(near.point.y));
                markers[i].setAttribute('opacity', 1);
                html += '<div class="tip-row"><span>' + s.label + '</span><b>'
                    + (s.tipFormat ? s.tipFormat(near.point.y) : format(near.point.y)) + '</b></div>';
                shown++;
            });

            if (!shown) { hide(); return; }
            tip.innerHTML = html;
            tip.style.display = 'block';
            const tipW = tip.offsetWidth;
            let left = gx + 12;
            if (left + tipW > width) left = gx - tipW - 12;
            tip.style.left = Math.max(4, left) + 'px';
            tip.style.top = (pad.top + 6) + 'px';
        });

        overlay.addEventListener('mouseleave', hide);
    }

    /** 凡例（2系列以上のときだけ呼ぶ。1系列なら見出しが系列名を兼ねる） */
    function renderLegend(container, series) {
        container.innerHTML = '';
        if (!series || series.length < 2) return;
        series.forEach(function (s) {
            const item = document.createElement('div');
            item.className = 'legend-item';
            const swatch = document.createElement('span');
            swatch.className = 'legend-swatch' + (s.dash ? ' dashed' : '');
            item.appendChild(swatch);
            const text = document.createElement('span');
            text.textContent = s.label;
            item.appendChild(text);
            container.appendChild(item);
        });
    }

    global.MDDChart = { render: render, renderLegend: renderLegend };
})(window);
