// "Export dashboard": a self-contained, read-only HTML snapshot that hides the exporter's paths.
import { describe, expect, it } from 'vitest';
import { DASHBOARD_NAME, anonymizeKeys, buildDashboardHtml, dashboardStamp, inlineJson, type DashboardData } from '../src/dashboardHtml';
import { parseWebviewMessage } from '../src/protocol';
import type { SeriesPayload } from '../src/types';
import { makeRun } from './helpers';

const A = '/home/alice/secret-project/traceml/runs/run-a';
const B = '/home/alice/secret-project/traceml/runs/run-b';
const series = (runKey: string): SeriesPayload => ({ runKey, metric: 'loss', step: [0, 1], epoch: [0, 1], wall: [0, 1], y: [2, 1], total: 2, version: 1 });

function data(): DashboardData {
  return {
    runs: [makeRun({ key: A, id: 'run-a', name: 'baseline', location: 'traceml/runs/run-a' }), makeRun({ key: B, id: 'run-b', name: 'high-lr', location: 'traceml/runs/run-b' })],
    roots: ['traceml/runs'],
    series: [series(A), series(B), series('/elsewhere/not-exported')],
    details: [{ key: A, meta: null, config: { lr: 0.1 }, configError: null, files: [] }],
    config: { staleAfterSeconds: 60, refreshIntervalSeconds: 5, maxPointsPerSeries: 5000 },
  };
}

describe('run keys are replaced by neutral ids', () => {
  it('in runs, series, details and the saved view', () => {
    const state = { version: 1, selected: [B, A, '/gone'], focused: A, colors: { [A]: 0, [B]: 3, '/gone': 1 }, plot: { hidden: [B], xMode: 'step' }, groupBy: ['param:lr'] };
    const out = anonymizeKeys(data(), state);
    expect(out.data.runs.map((r) => [r.key, r.name])).toEqual([['run-1', 'baseline'], ['run-2', 'high-lr']]);
    expect(out.data.series.map((s) => s.runKey)).toEqual(['run-1', 'run-2']); // series of runs not exported are dropped
    expect(out.data.details.map((d) => d.key)).toEqual(['run-1']);
    expect(out.state).toMatchObject({ selected: ['run-2', 'run-1'], focused: 'run-1', colors: { 'run-1': 0, 'run-2': 3 }, plot: { hidden: ['run-2'], xMode: 'step' }, groupBy: ['param:lr'] });
    expect(JSON.stringify(out)).not.toContain('alice');
  });
  it('runs folders outside the workspace (absolute labels) become their folder name', () => {
    const d = data();
    d.roots = ['/mnt/alice/exp/runs', 'traceml/runs'];
    d.runs[0]!.location = '/mnt/alice/exp/runs/run-a';
    const out = anonymizeKeys(d, { filters: { search: '', statuses: [], columns: { location: '^/mnt/alice/exp/runs/' } } });
    expect(out.data.roots).toEqual(['runs', 'traceml/runs']);
    expect(out.data.runs.map((r) => r.location)).toEqual(['runs/run-a', 'traceml/runs/run-b']);
    expect(out.state.filters).toEqual({ search: '', statuses: [], columns: { location: '^runs/' } });
    expect(JSON.stringify(out)).not.toContain('alice');
  });
  it('a focused run that is not exported is dropped', () => {
    expect(anonymizeKeys(data(), { focused: '/gone' }).state.focused).toBeNull();
  });
});

describe('the HTML page', () => {
  const page = () => {
    const { data: d, state } = anonymizeKeys(data(), { version: 1, selected: [A] });
    return buildDashboardHtml({ ...d, state, js: 'console.log("</script><script>alert(1)</script>"); // <!-- x', css: 'body{}</style><script>x</script>', logoSvg: '<svg/>', exportedAt: '2026-10-13T17:15:00.000Z', nonce: 'N0NCE' });
  };
  it('allows no network access and runs only its own inline scripts', () => {
    const html = page();
    const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)![1]!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("script-src 'nonce-N0NCE'");
    expect(csp).not.toMatch(/https?:|\*/);
    expect(html).not.toMatch(/<script[^>]*\ssrc=/);
    expect(html).not.toMatch(/<link[^>]*stylesheet/);
    // every executable script carries the nonce; the data blocks are inert JSON
    const tags = [...html.matchAll(/^<script([^>]*)>/gm)].map((m) => m[1]);
    expect(tags).toHaveLength(4);
    for (const t of tags) expect(t).toMatch(/nonce="N0NCE"|type="application\/json"/);
  });
  it('embedded code, styles and data cannot close their elements early', () => {
    const html = page();
    // data, state, host stub, bundle: each closed once, at the end of its line
    // (a `</script>` inside a <style> element is plain text there)
    expect(html.match(/<\/script>$/gm)).toHaveLength(4);
    expect(html.match(/<\/style>/g)).toHaveLength(2);
    expect(html).not.toContain('<!--');
    expect(html).toContain('console.log("<\\/script><script>alert(1)<\\/script>")');
    expect(html).toContain('body{}<\\/style><script>x</script>');
    expect(inlineJson({ s: '</script><!--\u2028' })).toBe('{"s":"\\u003c/script>\\u003c!--\\u2028"}');
  });
  it('marks itself as a snapshot, embeds the logo, and leaks no paths', () => {
    const html = page();
    expect(html).toContain('<meta name="traceml-snapshot" content="2026-10-13T17:15:00.000Z">');
    expect(html).toContain('content="data:image/svg+xml;base64,');
    expect(html).toContain('<title>TraceML dashboard · 2026-10-13 17:15 UTC</title>');
    expect(html).not.toContain('alice');
    const dataJson = /<script type="application\/json" id="traceml-data">(.*?)<\/script>/s.exec(html)![1]!;
    expect(JSON.parse(dataJson).runs.map((r: { key: string }) => r.key)).toEqual(['run-1', 'run-2']);
  });
});

describe('file name and messages', () => {
  it('timestamped file names match the cache pattern', () => {
    expect(dashboardStamp('2026-10-13T17:15:09.123Z')).toBe('20261013-171509');
    expect(DASHBOARD_NAME.test(`dashboard-${dashboardStamp('2026-10-13T17:15:09.123Z')}.html`)).toBe(true);
    for (const bad of ['dashboard-x.html', '../dashboard-20261013-171509.html', 'dashboard-20261013-171509.html.js']) expect(DASHBOARD_NAME.test(bad)).toBe(false);
  });
  it('validates the export request', () => {
    expect(parseWebviewMessage({ type: 'exportDashboard', runKeys: ['a'], chartKeys: ['a'], state: { version: 1 } })).toEqual({ type: 'exportDashboard', runKeys: ['a'], chartKeys: ['a'], state: { version: 1 } });
    expect(parseWebviewMessage({ type: 'exportDashboard', runKeys: 'a', chartKeys: [], state: {} })).toBeNull();
    expect(parseWebviewMessage({ type: 'exportDashboard', runKeys: [], chartKeys: [], state: [] })).toBeNull();
    expect(parseWebviewMessage({ type: 'exportDashboard', runKeys: [], chartKeys: [], state: { big: 'x'.repeat(600 * 1024) } })).toBeNull();
    expect(parseWebviewMessage({ type: 'copyDashboardPath' })).toEqual({ type: 'copyDashboardPath' });
    expect(parseWebviewMessage({ type: 'openDashboard' })).toEqual({ type: 'openDashboard' });
  });
});
