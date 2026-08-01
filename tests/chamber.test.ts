import { describe, it, expect } from 'vitest';
import { MATERIALS, getMaterial } from '../src/data/materials';
import {
  suggestChamberTemp, suggestTempRange, suggestMvsRange, suggestPaRange, suggestRetractionRange
} from '../src/logic/ranges';
import { validateAgainstPrinter } from '../src/logic/validation';
import type { PrinterProfile } from '../src/types';

function printer(over: Partial<PrinterProfile> = {}): PrinterProfile {
  return {
    id: 'pr', name: 'Test machine', manufacturer: 'Acme', nozzleDiameter: 0.4,
    maxNozzleTemp: 300, maxBedTemp: 120, extruderType: 'direct',
    retractionRange: { start: 0, end: 2 }, notes: '',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    ...over
  };
}

/** The owner's machine: heated chamber capped at 65 °C (printers.json). */
const X2D = printer({ name: 'Bambu Lab X2D', maxChamberTemp: 65, heatedChamber: true, maxVolumetricFlow: 22 });

describe('per-material chamber guidance', () => {
  it('gives every material an explicit answer — none stays silent', () => {
    for (const m of MATERIALS) {
      expect(m.chamber, `${m.id} has no chamber guidance`).toBeDefined();
      expect(['hot', 'ambient', 'unknown']).toContain(m.chamber.advice);
      expect(m.chamber.why.length).toBeGreaterThan(20);
    }
  });

  it('classifies the enclosure materials hot and the low-Tg ones ambient', () => {
    // Bambu ships chamber_temperatures only for ABS/ASA/PA/PC/PPA (50–65) and
    // leaves it at 0 for every PLA, PETG, PCTG and TPU preset.
    for (const id of ['ABS', 'ASA', 'PA', 'PA-CF', 'PA-GF', 'PC', 'PPA', 'PPS']) {
      expect(getMaterial(id).chamber.advice, id).toBe('hot');
    }
    for (const id of ['PLA', 'PLA+', 'PETG', 'PCTG', 'TPU']) {
      expect(getMaterial(id).chamber.advice, id).toBe('ambient');
    }
    expect(getMaterial('OTHER').chamber.advice).toBe('unknown');
  });

  it('runs ABS as hot as the machine allows, and names the vendor setpoint', () => {
    const s = suggestChamberTemp('ABS', X2D);
    expect(s.advice).toBe('hot');
    expect(s.suggestedC).toBe(65);
    expect(s.warnings.join(' ')).toContain('60');   // Bambu's own X2D ABS value
    expect(validateAgainstPrinter('chamberTemp', s.suggestedC!, X2D)).toEqual([]);
  });

  it('keeps the chamber OFF for PLA and PETG and says why, on a machine that can heat it', () => {
    for (const id of ['PLA', 'PETG']) {
      const s = suggestChamberTemp(id, X2D);
      expect(s.advice, id).toBe('ambient');
      expect(s.suggestedC, id).toBe(0);
      const all = `${s.headline} ${s.warnings.join(' ')}`.toLowerCase();
      expect(all, id).toContain('heat creep');
      expect(all, id).toContain('jam');
    }
    // The trap in one line: "set it to the max" must never be the PLA answer.
    expect(suggestChamberTemp('PLA', X2D).suggestedC)
      .not.toBe(suggestChamberTemp('ABS', X2D).suggestedC);
  });

  it('offers no number when the machine has no heated chamber, and still gives advice', () => {
    const open = printer({ heatedChamber: false });
    const s = suggestChamberTemp('ABS', open);
    expect(s.suggestedC).toBeUndefined();
    expect(s.headline.toLowerCase()).toContain('no heated chamber');
  });

  it('offers no number when nothing is sourced for the material', () => {
    expect(suggestChamberTemp('OTHER', X2D).suggestedC).toBeUndefined();
    expect(suggestChamberTemp('OTHER', X2D).headline.toLowerCase()).toContain('no chamber guidance');
    // PPS wants a hot chamber but no vendor setpoint is shipped for it.
    const pps = suggestChamberTemp('PPS', X2D);
    expect(pps.advice).toBe('hot');
    expect(pps.suggestedC).toBeUndefined();
  });

  it('names no number when the profile states no chamber limit, even for ABS', () => {
    // An unstated machine limit is not permission to pick a temperature.
    const s = suggestChamberTemp('ABS', printer({ heatedChamber: true }));
    expect(s.advice).toBe('hot');
    expect(s.suggestedC).toBeUndefined();
    expect(s.headline).toContain('70');    // the material ceiling is still stated
  });

  it('treats an explicit 0 °C chamber limit as "no chamber", not as a target', () => {
    const s = suggestChamberTemp('ABS', printer({ maxChamberTemp: 0 }));
    expect(s.suggestedC).toBeUndefined();
    expect(s.headline.toLowerCase()).toContain('no heated chamber');
  });

  it('clamps to the machine even when the vendor setpoint is higher', () => {
    // The case that must never pass through: the material data says 60 °C, the
    // machine says it cannot exceed 45 °C. The machine wins, every time.
    const cool = printer({ name: 'Small enclosure', maxChamberTemp: 45, heatedChamber: true });
    const abs = getMaterial('ABS');
    expect(abs.chamber.vendorC).toBeGreaterThan(45);
    const s = suggestChamberTemp('ABS', cool);
    expect(s.suggestedC).toBe(45);
    expect(s.suggestedC).not.toBe(abs.chamber.vendorC);
    expect(s.warnings.join(' ')).toContain('cannot reach');
    expect(validateAgainstPrinter('chamberTemp', s.suggestedC!, cool)).toEqual([]);

    // And the same for the owner's real 0–65 machine: nothing above 65 ever.
    for (const m of MATERIALS) {
      const v = suggestChamberTemp(m.id, X2D).suggestedC;
      if (v !== undefined) expect(v, m.id).toBeLessThanOrEqual(65);
    }
  });

  it('never suggests above the material ceiling even on a hotter machine', () => {
    const industrial = printer({ maxChamberTemp: 120, heatedChamber: true });
    const abs = suggestChamberTemp('ABS', industrial);
    expect(abs.suggestedC).toBe(getMaterial('ABS').chamber.maxC);
    expect(abs.suggestedC!).toBeLessThan(120);
    expect(abs.clamped).toBe(true);
  });
});

describe('chamber temperature is validated like every other temperature', () => {
  it('errors above the printer profile\'s chamber limit', () => {
    const issues = validateAgainstPrinter('chamberTemp', 80, X2D);
    expect(issues.some(i => i.level === 'error')).toBe(true);
    expect(issues[0].message).toContain('65');
  });

  it('stays silent when the profile does not state a chamber limit', () => {
    expect(validateAgainstPrinter('chamberTemp', 80, printer())).toEqual([]);
  });

  it('warns rather than errors when the profile has no heated chamber', () => {
    const issues = validateAgainstPrinter('chamberTemp', 60, printer({ heatedChamber: false }));
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe('warning');
  });

  it('passes a chamber-off recommendation', () => {
    expect(validateAgainstPrinter('chamberTemp', 0, printer({ heatedChamber: false }))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Property sweep: every material against hostile printer profiles.
// ---------------------------------------------------------------------------

const NOZZLE_LIMITS = [undefined, 0, 200, 240, 260, 300, 500];
const BED_LIMITS = [undefined, 0, 60, 110, 120];
const CHAMBER_LIMITS = [undefined, 0, 60, 65];
const FLOW_LIMITS = [undefined, 0, 110];

function hostilePrinters(): PrinterProfile[] {
  const out: PrinterProfile[] = [];
  for (const n of NOZZLE_LIMITS) {
    for (const b of BED_LIMITS) {
      for (const c of CHAMBER_LIMITS) {
        for (const f of FLOW_LIMITS) {
          for (const heated of [undefined, true, false]) {
            const p = printer({
              maxNozzleTemp: n as number,
              maxBedTemp: b as number,
              maxChamberTemp: c,
              maxVolumetricFlow: f,
              heatedChamber: heated
            });
            if (n === undefined) delete (p as Partial<PrinterProfile>).maxNozzleTemp;
            if (b === undefined) delete (p as Partial<PrinterProfile>).maxBedTemp;
            if (c === undefined) delete p.maxChamberTemp;
            if (f === undefined) delete p.maxVolumetricFlow;
            if (heated === undefined) delete p.heatedChamber;
            out.push(p);
          }
        }
      }
    }
  }
  return out;
}

const finite = (n: number | undefined): boolean => n === undefined || Number.isFinite(n);

describe('property sweep: no suggestion exceeds a stated machine limit', () => {
  const printers = hostilePrinters();

  it('sweeps every material against every hostile profile', () => {
    expect(printers.length).toBe(7 * 5 * 4 * 3 * 3);
    const bad: string[] = [];
    let checks = 0;

    for (const m of MATERIALS) {
      for (const p of printers) {
        checks++;
        const where = `${m.id} @ nozzle=${p.maxNozzleTemp} bed=${p.maxBedTemp} `
          + `chamber=${p.maxChamberTemp}/${p.heatedChamber} flow=${p.maxVolumetricFlow}`;
        const fail = (why: string): void => { bad.push(`${where}: ${why}`); };

        // --- chamber ---------------------------------------------------------
        const ch = suggestChamberTemp(m.id, p);
        if (!finite(ch.suggestedC)) fail(`chamber ${ch.suggestedC} is not finite`);
        if (ch.suggestedC !== undefined) {
          if (ch.suggestedC < 0) fail(`chamber ${ch.suggestedC} is negative`);
          if (typeof p.maxChamberTemp === 'number' && Number.isFinite(p.maxChamberTemp)
            && ch.suggestedC > p.maxChamberTemp) fail(`chamber ${ch.suggestedC} over machine limit`);
          if (m.chamber.maxC !== undefined && ch.suggestedC > m.chamber.maxC) {
            fail(`chamber ${ch.suggestedC} over material ceiling ${m.chamber.maxC}`);
          }
          // Anything displayed must survive the same check a nozzle temp gets.
          if (validateAgainstPrinter('chamberTemp', ch.suggestedC, p).some(i => i.level === 'error')) {
            fail(`chamber ${ch.suggestedC} fails its own validation`);
          }
        }
        if (!ch.headline.trim()) fail('chamber headline is empty');

        // --- nozzle temperature tower ---------------------------------------
        const t = suggestTempRange(m.id, p);
        if (![t.start, t.end, t.step].every(Number.isFinite)) fail(`tower ${t.start}→${t.end}/${t.step} not finite`);
        if (t.step <= 0) fail(`tower step ${t.step}`);
        if (t.start === t.end) fail('tower start equals end');
        if (t.start <= 0 || t.end <= 0) fail(`tower ${t.start}→${t.end} is at or below 0 °C`);
        if (typeof p.maxNozzleTemp === 'number' && p.maxNozzleTemp > 0
          && (t.start > p.maxNozzleTemp || t.end > p.maxNozzleTemp)) {
          fail(`tower ${t.start}→${t.end} over nozzle limit`);
        }

        // --- max volumetric speed --------------------------------------------
        const mv = suggestMvsRange(m.id, p);
        if (![mv.start, mv.end, mv.step].every(Number.isFinite)) fail('mvs range not finite');
        if (mv.step <= 0) fail(`mvs step ${mv.step}`);
        if (mv.end <= mv.start) fail(`mvs ${mv.start}→${mv.end} inverted`);
        if (mv.start <= 0) fail(`mvs start ${mv.start}`);
        // The test range deliberately reaches past the rating (that is how the
        // wall is found) but never grows because of it.
        if (mv.end > Math.max(m.mvsRange.end, (p.maxVolumetricFlow ?? 0) * 1.25 + 1)) {
          fail(`mvs end ${mv.end} grew beyond the documented 1.25× rule`);
        }

        // --- pressure advance / retraction ------------------------------------
        for (const feed of ['direct', 'bowden'] as const) {
          const pa = suggestPaRange(feed, m, false, { label: 'n', feed });
          if (![pa.start, pa.end, pa.step].every(Number.isFinite)) fail(`PA ${feed} not finite`);
          if (pa.step <= 0 || pa.end <= pa.start) fail(`PA ${feed} degenerate`);

          const r = suggestRetractionRange(feed, m, p, { label: 'n', feed });
          if (![r.start, r.end, r.step].every(Number.isFinite)) fail(`retraction ${feed} not finite`);
          if (r.step <= 0 || r.end <= r.start || r.start < 0) fail(`retraction ${feed} degenerate: ${r.start}→${r.end}`);
        }
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
    expect(checks).toBe(MATERIALS.length * printers.length);
  });
});

// ---------------------------------------------------------------------------
// The ABS/ASA ceiling, and what the headline is allowed to claim about it.
// ---------------------------------------------------------------------------

describe('the ABS/ASA chamber ceiling is the material’s own softening point', () => {
  it('never sits at or above the temperature the material distorts at', () => {
    // Bambu's ABS-specific numbers are filament_dev_drying_softening_temperature
    // 80 and filament_dev_ams_drying_heat_distortion_temperature 90; ASA's
    // softening figure is 85. fdm_filament_abs.json declares no
    // temperature_vitrification of its own — the 100 it appears to have is
    // inherited from fdm_filament_common.json, so Tg−10 gave 90: the exact
    // heat-distortion temperature, and 10 °C above the point this file's own
    // drying warning forbids.
    expect(getMaterial('ABS').chamber.maxC).toBe(70);
    expect(getMaterial('ASA').chamber.maxC).toBe(75);
    for (const id of ['ABS', 'ASA']) {
      const m = getMaterial(id);
      expect(m.chamber.maxC!, id).toBeLessThan(80);
      // The chamber ceiling and the drying warning must not contradict.
      expect(m.warnings.join(' '), id).toContain('80');
    }
  });

  it('does not change the number on the machine this was field-verified on', () => {
    // The X2D caps at 65 °C, below either ceiling, so its ABS advice is
    // untouched — the owner ran the chamber at max with no warping.
    expect(suggestChamberTemp('ABS', X2D).suggestedC).toBe(65);
    expect(suggestChamberTemp('ASA', X2D).suggestedC).toBe(65);
    expect(suggestChamberTemp('ABS', X2D).clamped).toBe(false);
  });

  it('says the MATERIAL held the number back when the machine could go higher', () => {
    const hot = printer({ name: 'Industrial', maxChamberTemp: 120, heatedChamber: true });
    const s = suggestChamberTemp('ABS', hot);
    expect(s.suggestedC).toBe(70);
    expect(s.clamped).toBe(true);
    expect(s.headline).toContain('the ceiling for this material');
    expect(s.headline).toContain('120');
    // The claim that used to be made regardless of which ceiling decided it.
    expect(s.headline).not.toContain('as warm as this machine allows');
  });

  it('still claims the machine ceiling when the machine really is the limit', () => {
    const s = suggestChamberTemp('ABS', X2D);
    expect(s.headline).toContain('as warm as this machine allows');
  });
});
