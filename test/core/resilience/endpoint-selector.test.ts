import { describe, it, expect } from 'vitest';
import { EndpointSelector, type EndpointState } from '../../../src/core/resilience/endpoint-selector.js';
import type { RemoteEndpoint } from '../../../src/core/resilience/types.js';

const endpoints: RemoteEndpoint[] = [
  { url: 'http://a', model: 'm', role: 'primary' },
  { url: 'http://b', model: 'm', role: 'peer' },
  { url: 'http://c', model: 'm', role: 'peer' },
];

describe('EndpointSelector', () => {
  it('priority: skips open circuit, returns first healthy', () => {
    const states = new Map<string, EndpointState>([
      ['http://a', { circuitState: 'open', concurrent: 0 }],
      ['http://b', { circuitState: 'closed', concurrent: 0 }],
      ['http://c', { circuitState: 'closed', concurrent: 0 }],
    ]);
    const sel = new EndpointSelector(endpoints, 'priority');
    expect(sel.pick(states)?.url).toBe('http://b');
  });

  it('priority: returns undefined when all circuits open', () => {
    const states = new Map<string, EndpointState>([
      ['http://a', { circuitState: 'open', concurrent: 0 }],
      ['http://b', { circuitState: 'open', concurrent: 0 }],
      ['http://c', { circuitState: 'open', concurrent: 0 }],
    ]);
    const sel = new EndpointSelector(endpoints, 'priority');
    expect(sel.pick(states)).toBeUndefined();
  });

  it('round-robin: cycles through healthy endpoints', () => {
    const states = new Map<string, EndpointState>();
    for (const e of endpoints) states.set(e.url, { circuitState: 'closed', concurrent: 0 });
    const sel = new EndpointSelector(endpoints, 'round-robin');
    const picks = [sel.pick(states)?.url, sel.pick(states)?.url, sel.pick(states)?.url, sel.pick(states)?.url];
    expect(picks).toEqual(['http://a', 'http://b', 'http://c', 'http://a']);
  });

  it('weighted-random: respects weights over many picks', () => {
    const weighted: RemoteEndpoint[] = [
      { url: 'http://x', model: 'm', weight: 9 },
      { url: 'http://y', model: 'm', weight: 1 },
    ];
    const states = new Map<string, EndpointState>();
    for (const e of weighted) states.set(e.url, { circuitState: 'closed', concurrent: 0 });
    const sel = new EndpointSelector(weighted, 'weighted-random');
    const counts = { x: 0, y: 0 };
    for (let i = 0; i < 1000; i++) {
      const pick = sel.pick(states);
      if (pick?.url === 'http://x') counts.x++;
      else counts.y++;
    }
    // x should get ~90%
    expect(counts.x).toBeGreaterThan(counts.y * 5);
  });

  it('least-connections: picks lowest concurrent', () => {
    const states = new Map<string, EndpointState>([
      ['http://a', { circuitState: 'closed', concurrent: 5 }],
      ['http://b', { circuitState: 'closed', concurrent: 1 }],
      ['http://c', { circuitState: 'closed', concurrent: 3 }],
    ]);
    const sel = new EndpointSelector(endpoints, 'least-connections');
    expect(sel.pick(states)?.url).toBe('http://b');
  });

  it('least-connections: ties broken by endpoint order', () => {
    const states = new Map<string, EndpointState>([
      ['http://a', { circuitState: 'closed', concurrent: 0 }],
      ['http://b', { circuitState: 'closed', concurrent: 0 }],
      ['http://c', { circuitState: 'closed', concurrent: 0 }],
    ]);
    const sel = new EndpointSelector(endpoints, 'least-connections');
    expect(sel.pick(states)?.url).toBe('http://a');
  });

  it('any strategy: skips open + half-open circuits', () => {
    const states = new Map<string, EndpointState>([
      ['http://a', { circuitState: 'half-open', concurrent: 0 }],
      ['http://b', { circuitState: 'closed', concurrent: 0 }],
      ['http://c', { circuitState: 'open', concurrent: 0 }],
    ]);
    const sel = new EndpointSelector(endpoints, 'round-robin');
    expect(sel.pick(states)?.url).toBe('http://b');
  });

  it('empty endpoints returns undefined', () => {
    const sel = new EndpointSelector([], 'round-robin');
    expect(sel.pick(new Map())).toBeUndefined();
  });
});
