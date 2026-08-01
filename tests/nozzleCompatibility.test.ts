import { describe, it, expect } from 'vitest';
import {
  readFilamentPresetFacts, readMachinePresetFacts, machineNozzleCount,
  decodeExtruderCompatibility, splitPresetName, vendorAnnotatedSibling,
  nozzleFilamentVerdict, compatibilityRank, compatibilityOverrideNote,
  resolveFilamentPresetFacts
} from '../src/logic/validation';
import { nozzleTopology } from '../src/logic/ranges';
import {
  compatibilityGateIssues, compatibilityOverrideRecord, showsCompatibilityPanel
} from '../src/ui/projectNew';
import { getMaterial } from '../src/data/materials';
import type { CompatibilityLevel, PrinterProfile } from '../src/types';

// ---------------------------------------------------------------------------
// Fixtures are shaped exactly like the presets installed on a real machine:
// every Bambu value is a STRING inside an array, even the integers.
// ---------------------------------------------------------------------------

/** Bambu Lab X2D 0.4 nozzle machine preset (main = direct, aux = bowden). */
const X2D_MACHINE = {
  extruder_type: ['Direct Drive', 'Bowden'],
  nozzle_diameter: ['0.4', '0.4'],
  extruder_variant_list: [
    'Direct Drive Standard,Direct Drive High Flow,Direct Drive E3D High Flow',
    'Bowden Standard,Bowden High Flow,Bowden E3D High Flow'
  ],
  printer_extruder_variant: [
    'Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive E3D High Flow',
    'Bowden Standard', 'Bowden High Flow', 'Bowden E3D High Flow'
  ],
  printer_extruder_id: ['1', '1', '1', '2', '2', '2']
};

/** Bambu Lab H2C 0.4 nozzle: BOTH extruders direct drive, type-based blocks. */
const H2C_MACHINE = {
  extruder_type: ['Direct Drive', 'Direct Drive'],
  nozzle_diameter: ['0.4', '0.4'],
  extruder_variant_list: [
    'Direct Drive Standard,Direct Drive High Flow,Direct Drive E3D High Flow',
    'Direct Drive Standard,Direct Drive High Flow'
  ],
  unprintable_filament_types: ['TPU', 'PPS-CF,PPA-CF']
};

/** A single-nozzle machine that still offers three hotend VARIANTS (P2S-like). */
const P2S_MACHINE = {
  extruder_type: ['Direct Drive'],
  nozzle_diameter: ['0.4'],
  extruder_variant_list: ['Direct Drive Standard,Direct Drive High Flow,Direct Drive E3D High Flow']
};

const bambuAbsX2d = {
  name: 'Bambu ABS @BBL X2D 0.4 nozzle',
  filament_type: ['ABS'],
  filament_vendor: ['Bambu Lab'],
  filament_printable: ['3'],
  filament_extruder_compatibility: ['24'] // aux level 3 = "warning"
};

const genericAbsX2d = {
  name: 'Generic ABS @BBL X2D 0.4 nozzle',
  filament_type: ['ABS'],
  filament_vendor: ['Generic'],
  filament_printable: ['3']
  // NO filament_extruder_compatibility — the owner's real gap.
};

const genericTpuX2d = {
  name: 'Generic TPU @BBL X2D 0.4 nozzle',
  filament_type: ['TPU'],
  filament_vendor: ['Generic'],
  filament_printable: ['1'] // main only — bit 1 clear
};

const bambuPlaSilkX2d = {
  name: 'Bambu PLA Silk @BBL X2D 0.4 nozzle',
  filament_type: ['PLA'],
  filament_vendor: ['Bambu Lab'],
  filament_printable: ['3'],
  filament_extruder_compatibility: ['16'] // aux level 2 = critical
};

const bambuPlaBasicX2d = {
  name: 'Bambu PLA Basic @BBL X2D 0.4 nozzle',
  filament_type: ['PLA'],
  filament_vendor: ['Bambu Lab'],
  filament_printable: ['3'],
  filament_extruder_compatibility: ['0'] // clean on both
};

const genericPlaBasicX2d = {
  name: 'Generic PLA Basic @BBL X2D 0.4 nozzle',
  filament_type: ['PLA'],
  filament_vendor: ['Generic'],
  filament_printable: ['3']
};

const genericPlaSilkX2d = {
  name: 'Generic PLA Silk @BBL X2D 0.4 nozzle',
  filament_type: ['PLA'],
  filament_vendor: ['Generic'],
  filament_printable: ['3']
};

const genericPpaCfH2c = {
  name: 'Generic PPA-CF @BBL H2C 0.4 nozzle',
  filament_type: ['PPA-CF'],
  filament_vendor: ['Generic'],
  filament_printable: ['1']
};

const AUX = { extruderIndex: 1, nozzleLabel: 'Auxiliary (bowden)', feed: 'bowden' as const };
const MAIN = { extruderIndex: 0, nozzleLabel: 'Main (direct drive)', feed: 'direct' as const };

// ---------------------------------------------------------------------------

describe('reading compatibility out of installed preset data', () => {
  it('parses the Bambu string-array encoding of every key it uses', () => {
    const f = readFilamentPresetFacts(bambuAbsX2d);
    expect(f.name).toBe('Bambu ABS @BBL X2D 0.4 nozzle');
    expect(f.filamentType).toBe('ABS');
    expect(f.vendor).toBe('Bambu Lab');
    expect(f.printableMask).toBe(3);
    expect(f.extruderCompatibility).toBe(24);
    expect(f.annotated).toBe(true);

    const m = readMachinePresetFacts(X2D_MACHINE);
    expect(m.extruderTypes).toEqual(['Direct Drive', 'Bowden']);
    expect(m.nozzleDiameters).toEqual(['0.4', '0.4']);
    expect(m.extruderVariantList).toHaveLength(2);
  });

  it('treats a preset with no compatibility record as UNANNOTATED, not as clean', () => {
    const f = readFilamentPresetFacts(genericAbsX2d);
    expect(f.printableMask).toBe(3);
    expect(f.extruderCompatibility).toBeUndefined();
    expect(f.annotated).toBe(false);
  });

  it('survives junk without inventing anything', () => {
    for (const junk of [null, undefined, 42, 'nope', [], { filament_printable: ['nil'] }]) {
      const f = readFilamentPresetFacts(junk);
      expect(f.printableMask).toBeUndefined();
      expect(f.annotated).toBe(false);
      expect(f.extruderVariants).toEqual([]);
    }
    const m = readMachinePresetFacts('nope');
    expect(machineNozzleCount(m)).toBeUndefined();
  });

  it('decodes filament_extruder_compatibility three bits per extruder', () => {
    expect(decodeExtruderCompatibility(24, 0)).toBe(0);
    expect(decodeExtruderCompatibility(24, 1)).toBe(3); // warning
    expect(decodeExtruderCompatibility(16, 1)).toBe(2); // critical warning
    expect(decodeExtruderCompatibility(8, 1)).toBe(1);  // error
    expect(decodeExtruderCompatibility(0, 1)).toBe(0);
    // A nonzero level on extruder 0 must decode too — see the open question in
    // the research: Bambu annotates only the aux today, but the decoder cannot
    // assume that.
    expect(decodeExtruderCompatibility(26, 0)).toBe(2);
    expect(decodeExtruderCompatibility(26, 1)).toBe(3);
  });

  it('counts PHYSICAL nozzles from nozzle_diameter, never from the variant slots', () => {
    expect(machineNozzleCount(readMachinePresetFacts(X2D_MACHINE))).toBe(2);
    expect(machineNozzleCount(readMachinePresetFacts(H2C_MACHINE))).toBe(2);
    // Three hotend variants, ONE physical nozzle. Slot count carries no nozzle
    // information — this is the trap that must never be re-introduced.
    const p2s = readMachinePresetFacts(P2S_MACHINE);
    expect(p2s.extruderVariantList[0].split(',')).toHaveLength(3);
    expect(machineNozzleCount(p2s)).toBe(1);
  });
});

describe('the four gates, each on data read from a real preset shape', () => {
  it('gate B — a cleared filament_printable bit blocks the aux nozzle', () => {
    const v = nozzleFilamentVerdict({
      ...AUX, material: getMaterial('TPU'),
      machine: readMachinePresetFacts(X2D_MACHINE),
      filament: readFilamentPresetFacts(genericTpuX2d)
    });
    expect(v.level).toBe('blocked');
    expect(v.inferred).toBe(false);
    expect(v.evidence.some(e => e.source.includes('filament_printable'))).toBe(true);
    // ...and the same filament on the MAIN nozzle is not blocked by that bit.
    const main = nozzleFilamentVerdict({
      ...MAIN, material: getMaterial('TPU'),
      machine: readMachinePresetFacts(X2D_MACHINE),
      filament: readFilamentPresetFacts(genericTpuX2d)
    });
    expect(main.level).not.toBe('blocked');
  });

  it('gate C — level 3 is a caution on the aux and silence on the main', () => {
    const aux = nozzleFilamentVerdict({
      ...AUX, material: getMaterial('ABS'),
      machine: readMachinePresetFacts(X2D_MACHINE),
      filament: readFilamentPresetFacts(bambuAbsX2d)
    });
    expect(aux.level).toBe('caution');
    expect(aux.inferred).toBe(false);
    expect(aux.headline.toLowerCase()).toContain('not recommended');

    const main = nozzleFilamentVerdict({
      ...MAIN, material: getMaterial('ABS'),
      machine: readMachinePresetFacts(X2D_MACHINE),
      filament: readFilamentPresetFacts(bambuAbsX2d)
    });
    expect(main.level).toBe('clear');
  });

  it('gate C — level 2 is critical, level 1 is blocked', () => {
    const critical = nozzleFilamentVerdict({
      ...AUX, material: getMaterial('PLA'),
      filament: readFilamentPresetFacts(bambuPlaSilkX2d)
    });
    expect(critical.level).toBe('critical');
    const blocked = nozzleFilamentVerdict({
      ...AUX, material: getMaterial('PLA'),
      filament: readFilamentPresetFacts({ ...bambuPlaSilkX2d, filament_extruder_compatibility: ['8'] })
    });
    expect(blocked.level).toBe('blocked');
  });

  it('gate D — a machine-level unprintable filament TYPE blocks that extruder', () => {
    const right = nozzleFilamentVerdict({
      extruderIndex: 1, nozzleLabel: 'Right nozzle', feed: 'direct',
      material: getMaterial('PPA'),
      machine: readMachinePresetFacts(H2C_MACHINE),
      filament: readFilamentPresetFacts(genericPpaCfH2c)
    });
    expect(right.level).toBe('blocked');
    expect(right.evidence.some(e => e.source.includes('unprintable_filament_types'))).toBe(true);
    // Polarity inverts per extruder: the LEFT nozzle is the one that cannot
    // print TPU on this machine, and the right one that cannot print PPA-CF.
    const leftTpu = nozzleFilamentVerdict({
      extruderIndex: 0, nozzleLabel: 'Left nozzle', feed: 'direct',
      material: getMaterial('TPU'),
      machine: readMachinePresetFacts(H2C_MACHINE),
      filament: readFilamentPresetFacts({ name: 'x', filament_type: ['TPU'] })
    });
    expect(leftTpu.level).toBe('blocked');
  });

  it('gate A — a preset that names no variant this nozzle has is blocked', () => {
    const v = nozzleFilamentVerdict({
      ...AUX, material: getMaterial('PETG'),
      machine: readMachinePresetFacts(X2D_MACHINE),
      filament: readFilamentPresetFacts({
        name: 'Direct-only preset',
        filament_type: ['PETG'],
        filament_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow']
      })
    });
    expect(v.level).toBe('blocked');
    expect(v.evidence.some(e => e.source.includes('extruder_variant_list'))).toBe(true);
  });

  it('reports the STRONGEST gate but keeps every gate\'s evidence', () => {
    const v = nozzleFilamentVerdict({
      ...AUX, material: getMaterial('TPU'),
      machine: readMachinePresetFacts(X2D_MACHINE),
      filament: readFilamentPresetFacts({ ...genericTpuX2d, filament_extruder_compatibility: ['24'] })
    });
    expect(v.level).toBe('blocked');                 // gate B wins over gate C
    expect(v.evidence.length).toBeGreaterThan(1);    // but the level-3 line stays
  });
});

describe('never a block — only a warning the user can override', () => {
  const levels: CompatibilityLevel[] = ['blocked', 'critical', 'caution', 'clear', 'unknown'];

  it('no verdict, at any level, ever claims to stop the calibration', () => {
    const cases = [
      { ...AUX, material: getMaterial('TPU'), filament: readFilamentPresetFacts(genericTpuX2d) },
      { ...AUX, material: getMaterial('PLA'), filament: readFilamentPresetFacts(bambuPlaSilkX2d) },
      { ...AUX, material: getMaterial('ABS'), filament: readFilamentPresetFacts(bambuAbsX2d) },
      { ...MAIN, material: getMaterial('ABS'), filament: readFilamentPresetFacts(bambuAbsX2d) },
      { ...AUX, material: getMaterial('PETG') }
    ];
    const seen = new Set<CompatibilityLevel>();
    for (const c of cases) {
      const v = nozzleFilamentVerdict(c);
      expect(v.blocksCalibration).toBe(false);
      seen.add(v.level);
    }
    expect(seen.size).toBeGreaterThan(2);
    expect(levels).toContain([...seen][0]);
  });

  it('asks for an acknowledgement on the serious levels and stays quiet on the rest', () => {
    const ack = (l: CompatibilityLevel) => nozzleFilamentVerdict({
      ...AUX, material: getMaterial('PLA'),
      filament: readFilamentPresetFacts({
        name: 'x', filament_type: ['PLA'], filament_printable: ['3'],
        filament_extruder_compatibility: [String({ blocked: 8, critical: 16, caution: 24, clear: 0, unknown: 0 }[l])]
      })
    }).needsAcknowledgement;
    expect(ack('blocked')).toBe(true);
    expect(ack('critical')).toBe(true);
    expect(ack('clear')).toBe(false);
  });
});

describe('silence is not approval', () => {
  it('the owner\'s live case: Generic ABS carries no record, so the verdict is unknown', () => {
    const v = nozzleFilamentVerdict({
      ...AUX, material: getMaterial('ABS'),
      machine: readMachinePresetFacts(X2D_MACHINE),
      filament: readFilamentPresetFacts(genericAbsX2d)
    });
    expect(v.level).toBe('unknown');
    expect(v.headline.toLowerCase()).toMatch(/not .*approval|could not determine/);
  });

  it('a printer and a filament we know nothing about degrade to unknown', () => {
    const v = nozzleFilamentVerdict({
      extruderIndex: 1, material: getMaterial('PETG')
    });
    expect(v.level).toBe('unknown');
    expect(v.blocksCalibration).toBe(false);
    expect(v.needsAcknowledgement).toBe(false);
    expect(v.headline.toLowerCase()).toContain('could not determine');
  });

  it('clear is only ever reached when a compatibility record was actually read', () => {
    // printable bit set, no annotation → still unknown, never clear.
    const silent = nozzleFilamentVerdict({
      ...MAIN, material: getMaterial('ABS'),
      filament: readFilamentPresetFacts(genericAbsX2d)
    });
    expect(silent.level).toBe('unknown');
    const read = nozzleFilamentVerdict({
      ...MAIN, material: getMaterial('ABS'),
      filament: readFilamentPresetFacts(bambuAbsX2d)
    });
    expect(read.level).toBe('clear');
  });
});

describe('material fallback where the preset data is silent', () => {
  it('flexible filament on a bowden-fed nozzle is flagged as an inference', () => {
    const v = nozzleFilamentVerdict({ ...AUX, material: getMaterial('TPU') });
    expect(v.level).toBe('critical');
    expect(v.inferred).toBe(true);
    expect(v.evidence.some(e => e.inferred)).toBe(true);
    // The headline must say whose reading this is — it is not the slicer's.
    expect(v.headline.toLowerCase()).toContain('own reading');
  });

  it('the same filament on a direct-drive nozzle gets no such inference', () => {
    const v = nozzleFilamentVerdict({ ...MAIN, material: getMaterial('TPU') });
    expect(v.level).toBe('unknown');
  });

  it('an ordinary single-nozzle bowden printer is not gated — there is no other nozzle', () => {
    // A flexible on the only nozzle of a bowden machine is a difficulty, not a
    // choice. The PA and retraction guidance already covers it; a gate here
    // would demand a tick without offering an alternative.
    const v = nozzleFilamentVerdict({
      extruderIndex: 0, nozzleLabel: 'Nozzle', feed: 'bowden', material: getMaterial('TPU')
    });
    expect(v.level).toBe('unknown');
    expect(v.needsAcknowledgement).toBe(false);
  });

  it('read data outranks the inference but never silences it', () => {
    const v = nozzleFilamentVerdict({
      ...AUX, material: getMaterial('TPU'),
      filament: readFilamentPresetFacts(genericTpuX2d)
    });
    expect(v.level).toBe('blocked');       // gate B, read
    expect(v.inferred).toBe(false);        // the LEVEL is not an inference
    expect(v.evidence.some(e => e.inferred)).toBe(true); // the material line stays
  });
});

describe('vendor-annotated sibling advisory', () => {
  const library = [genericAbsX2d, bambuAbsX2d, genericPlaBasicX2d, bambuPlaBasicX2d,
    genericPlaSilkX2d, bambuPlaSilkX2d].map(p => ({ name: p.name, facts: readFilamentPresetFacts(p) }));

  it('splits a Bambu preset name into vendor, material label and scope', () => {
    expect(splitPresetName('Generic ABS @BBL X2D 0.4 nozzle'))
      .toEqual({ vendor: 'Generic', label: 'ABS', scope: 'BBL X2D 0.4 nozzle' });
    expect(splitPresetName('Bambu PLA Silk @BBL X2D 0.4 nozzle'))
      .toEqual({ vendor: 'Bambu', label: 'PLA Silk', scope: 'BBL X2D 0.4 nozzle' });
    expect(splitPresetName('NoScope')).toBeNull();
  });

  it('matches on the material LABEL, not on filament_type', () => {
    const target = { name: genericPlaSilkX2d.name, facts: readFilamentPresetFacts(genericPlaSilkX2d) };
    const silk = vendorAnnotatedSibling(target, library, 1);
    expect(silk?.presetName).toBe('Bambu PLA Silk @BBL X2D 0.4 nozzle');
    expect(silk?.level).toBe('critical');

    // Both are filament_type "PLA". A type-keyed fallback would condemn Basic
    // along with Silk; a label-keyed one must not.
    const basicTarget = { name: genericPlaBasicX2d.name, facts: readFilamentPresetFacts(genericPlaBasicX2d) };
    expect(vendorAnnotatedSibling(basicTarget, library, 1)).toBeNull();
  });

  it('feeds an advisory into the verdict, named as an inference about someone else\'s preset', () => {
    const target = { name: genericAbsX2d.name, facts: readFilamentPresetFacts(genericAbsX2d) };
    const advisory = vendorAnnotatedSibling(target, library, 1);
    expect(advisory?.presetName).toBe('Bambu ABS @BBL X2D 0.4 nozzle');
    const v = nozzleFilamentVerdict({
      ...AUX, material: getMaterial('ABS'),
      machine: readMachinePresetFacts(X2D_MACHINE),
      filament: target.facts,
      vendorAdvisory: advisory
    });
    expect(v.level).toBe('caution');
    expect(v.inferred).toBe(true);
    expect(v.evidence.some(e => e.detail.includes('Bambu ABS @BBL X2D 0.4 nozzle'))).toBe(true);
    expect(v.evidence.some(e => e.detail.includes(genericAbsX2d.name))).toBe(true);
  });

  it('an advisory can never escalate to blocked — it is someone else\'s preset', () => {
    const lib = [{
      name: 'Bambu Weird @BBL X2D 0.4 nozzle',
      facts: readFilamentPresetFacts({
        name: 'Bambu Weird @BBL X2D 0.4 nozzle', filament_type: ['ABS'],
        filament_printable: ['3'], filament_extruder_compatibility: ['8'] // level 1
      })
    }];
    const target = {
      name: 'Generic Weird @BBL X2D 0.4 nozzle',
      facts: readFilamentPresetFacts({ name: 'Generic Weird @BBL X2D 0.4 nozzle', filament_type: ['ABS'] })
    };
    const advisory = vendorAnnotatedSibling(target, lib, 1);
    expect(advisory?.level).toBe('critical');
    expect(compatibilityRank('critical')).toBeLessThan(compatibilityRank('blocked'));
  });

  it('never offers a sibling for a preset that carries its own record', () => {
    const target = { name: bambuAbsX2d.name, facts: readFilamentPresetFacts(bambuAbsX2d) };
    expect(vendorAnnotatedSibling(target, library, 1)).toBeNull();
  });

  it('never matches across printers — the scope suffix must be identical', () => {
    const target = {
      name: 'Generic ABS @BBL H2C 0.4 nozzle',
      facts: readFilamentPresetFacts({ name: 'Generic ABS @BBL H2C 0.4 nozzle', filament_type: ['ABS'] })
    };
    expect(vendorAnnotatedSibling(target, library, 1)).toBeNull();
  });
});

describe('resolving through the inherits chain (the preset people actually calibrate)', () => {
  // The owner's real file: a delta that declares a slot legend and a flow ratio
  // and inherits everything else.
  const ownersClone = {
    name: 'Generic ABS Flow Rate Calibrated',
    raw: {
      name: 'Generic ABS Flow Rate Calibrated',
      inherits: 'Generic ABS @BBL X2D 0.4 nozzle',
      filament_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow', 'Bowden Standard', 'Bowden High Flow'],
      filament_flow_ratio: ['0.967575', 'nil', 'nil', 'nil']
    },
    parentName: 'Generic ABS @BBL X2D 0.4 nozzle'
  };
  const chain: Record<string, { name: string; raw: unknown; parentName?: string | null }> = {
    'Generic ABS Flow Rate Calibrated': ownersClone,
    'Generic ABS @BBL X2D 0.4 nozzle': {
      name: 'Generic ABS @BBL X2D 0.4 nozzle', raw: genericAbsX2d, parentName: 'Generic ABS @base'
    },
    'Generic ABS @base': {
      name: 'Generic ABS @base', raw: { name: 'Generic ABS @base', filament_type: ['ABS'], filament_vendor: ['Generic'] }, parentName: null
    },
    'Bambu ABS @BBL X2D 0.4 nozzle': {
      name: 'Bambu ABS @BBL X2D 0.4 nozzle', raw: bambuAbsX2d, parentName: null
    }
  };
  const lookup = (n: string) => chain[n];

  it('picks up the compatibility keys the delta inherits, and says where from', () => {
    const f = resolveFilamentPresetFacts(ownersClone, lookup);
    expect(f.name).toBe('Generic ABS Flow Rate Calibrated');
    expect(f.printableMask).toBe(3);
    expect(f.inheritedFrom).toBe('Generic ABS @BBL X2D 0.4 nozzle');
    expect(f.filamentType).toBe('ABS');   // two levels up
    expect(f.annotated).toBe(false);      // nothing in the chain is annotated
    // The clone's own legend must win over anything inherited.
    expect(f.extruderVariants).toHaveLength(4);
  });

  it('finds the vendor sibling through the ANCESTOR name when the clone is freely named', () => {
    const facts = resolveFilamentPresetFacts(ownersClone, lookup);
    expect(facts.scopedName).toBe('Generic ABS @BBL X2D 0.4 nozzle');
    const advisory = vendorAnnotatedSibling(
      { name: facts.name!, facts },
      [{ name: 'Bambu ABS @BBL X2D 0.4 nozzle', facts: readFilamentPresetFacts(bambuAbsX2d) }],
      1
    );
    expect(advisory?.presetName).toBe('Bambu ABS @BBL X2D 0.4 nozzle');
    expect(advisory?.level).toBe('caution');
  });

  it('an inherited compatibility record is reported with its source file named', () => {
    const clone = {
      name: 'My ABS', raw: { name: 'My ABS', inherits: 'Bambu ABS @BBL X2D 0.4 nozzle' },
      parentName: 'Bambu ABS @BBL X2D 0.4 nozzle'
    };
    const facts = resolveFilamentPresetFacts(clone, lookup);
    expect(facts.annotated).toBe(true);
    expect(facts.extruderCompatibility).toBe(24);
    const v = nozzleFilamentVerdict({ ...AUX, material: getMaterial('ABS'), filament: facts });
    expect(v.level).toBe('caution');
    expect(v.evidence.some(e => e.source.includes('inherited from Bambu ABS @BBL X2D 0.4 nozzle'))).toBe(true);
  });

  it('a broken inherits loop terminates instead of hanging', () => {
    const a = { name: 'A', raw: { name: 'A' }, parentName: 'B' };
    const b = { name: 'B', raw: { name: 'B' }, parentName: 'A' };
    const loop = (n: string) => ({ A: a, B: b }[n]);
    const f = resolveFilamentPresetFacts(a, loop);
    expect(f.printableMask).toBeUndefined();
    expect(f.annotated).toBe(false);
  });

  it('a missing parent just stops the walk', () => {
    const orphan = {
      name: 'Generic Orphan @BBL X2D 0.4 nozzle',
      raw: { name: 'Generic Orphan @BBL X2D 0.4 nozzle' }, parentName: 'Nowhere'
    };
    const f = resolveFilamentPresetFacts(orphan, () => undefined);
    expect(f.annotated).toBe(false);
    expect(f.scopedName).toBe('Generic Orphan @BBL X2D 0.4 nozzle');
  });

  it('a name with no material label cannot be matched to anything', () => {
    // "Orphan @…" has a vendor token and no material — there is nothing to
    // match on, so it must resolve to no scoped name rather than to a guess.
    expect(splitPresetName('Orphan @BBL X2D 0.4 nozzle')).toBeNull();
  });

  it('never matches through an abstract @base node — it is printer-agnostic', () => {
    const target = {
      name: 'Generic ABS @base',
      facts: readFilamentPresetFacts({ name: 'Generic ABS @base', filament_type: ['ABS'] })
    };
    const lib = [{
      name: 'Bambu ABS @base',
      facts: readFilamentPresetFacts({
        name: 'Bambu ABS @base', filament_type: ['ABS'],
        filament_printable: ['3'], filament_extruder_compatibility: ['24']
      })
    }];
    expect(vendorAnnotatedSibling(target, lib, 1)).toBeNull();
  });
});

describe('recording an override so later guidance stays honest', () => {
  it('turns the record into a sentence that names the level and the nozzle', () => {
    const note = compatibilityOverrideNote({
      at: '2026-08-01T10:00:00.000Z', level: 'caution',
      headline: 'The installed preset data marks ABS as not recommended on Auxiliary (bowden).',
      evidence: ['filament_extruder_compatibility = 24'],
      nozzleIndex: 1, nozzleLabel: 'Auxiliary (bowden)', material: 'ABS',
      presetName: 'Bambu ABS @BBL X2D 0.4 nozzle', inferred: false
    });
    expect(note).toContain('Auxiliary (bowden)');
    expect(note).toContain('ABS');
    expect(note!.toLowerCase()).toContain('chose to calibrate');
    expect(compatibilityOverrideNote(undefined)).toBeNull();
  });
});

describe('the New Project gate — an acknowledgement, never a block', () => {
  const verdictFor = (level: CompatibilityLevel) => nozzleFilamentVerdict({
    ...AUX, material: getMaterial('PLA'),
    filament: readFilamentPresetFacts({
      name: 'x', filament_type: ['PLA'], filament_printable: ['3'],
      filament_extruder_compatibility: [String({ blocked: 8, critical: 16, caution: 24, clear: 0, unknown: 0 }[level])]
    })
  });

  it('a flagged combination cannot be created silently — and the tick always clears it', () => {
    for (const level of ['blocked', 'critical', 'caution'] as CompatibilityLevel[]) {
      const v = verdictFor(level);
      expect(v.needsAcknowledgement).toBe(true);
      const blockedByGate = compatibilityGateIssues(v, false);
      expect(blockedByGate).toHaveLength(1);
      expect(blockedByGate[0].message.toLowerCase()).toContain('anyway');
      // The tick is the whole mechanism: nothing else is required, and no
      // combination of inputs can make it insufficient.
      expect(compatibilityGateIssues(v, true)).toHaveLength(0);
      expect(v.blocksCalibration).toBe(false);
    }
  });

  it('a clear or unread verdict raises nothing at all', () => {
    expect(compatibilityGateIssues(verdictFor('clear'), false)).toHaveLength(0);
    expect(compatibilityGateIssues(nozzleFilamentVerdict({ ...MAIN, material: getMaterial('PETG') }), false)).toHaveLength(0);
    expect(compatibilityGateIssues(null, false)).toHaveLength(0);
  });

  it('records the override with the level, headline and evidence as shown', () => {
    const v = verdictFor('caution');
    const rec = compatibilityOverrideRecord({
      verdict: v, acknowledged: true, nozzleIndex: 1,
      nozzleLabel: 'Auxiliary (bowden)', material: 'ABS', presetName: 'Bambu ABS @BBL X2D 0.4 nozzle'
    });
    expect(rec).not.toBeNull();
    expect(rec!.level).toBe('caution');
    expect(rec!.headline).toBe(v.headline);
    expect(rec!.evidence.length).toBe(v.evidence.length);
    expect(rec!.nozzleIndex).toBe(1);
    expect(rec!.presetName).toBe('Bambu ABS @BBL X2D 0.4 nozzle');
    expect(compatibilityOverrideNote(rec!)).toContain('Auxiliary (bowden)');
  });

  it('records nothing when nothing was overridden', () => {
    const base = { nozzleIndex: 0, material: 'ABS' as const };
    expect(compatibilityOverrideRecord({ verdict: verdictFor('caution'), acknowledged: false, ...base })).toBeNull();
    expect(compatibilityOverrideRecord({ verdict: verdictFor('clear'), acknowledged: true, ...base })).toBeNull();
    expect(compatibilityOverrideRecord({ verdict: null, acknowledged: true, ...base })).toBeNull();
  });

  it('a single-nozzle machine sees the panel only when there is a real warning', () => {
    // Dual-nozzle: always, because "which nozzle" is the question being asked.
    expect(showsCompatibilityPanel(verdictFor('clear'), true)).toBe(true);
    expect(showsCompatibilityPanel(nozzleFilamentVerdict({ ...MAIN, material: getMaterial('PETG') }), true)).toBe(true);
    // Single-nozzle: nothing unless the data actually says something.
    expect(showsCompatibilityPanel(nozzleFilamentVerdict({ ...MAIN, material: getMaterial('PETG') }), false)).toBe(false);
    expect(showsCompatibilityPanel(verdictFor('clear'), false)).toBe(false);
    expect(showsCompatibilityPanel(verdictFor('blocked'), false)).toBe(true);
    expect(showsCompatibilityPanel(null, true)).toBe(false);
  });
});

describe('physical nozzle topology (never a preset slot count)', () => {
  const base: PrinterProfile = {
    id: 'p', name: 'P', manufacturer: '', nozzleDiameter: 0.4,
    maxNozzleTemp: 300, maxBedTemp: 100, extruderType: 'direct',
    retractionRange: { start: 0, end: 2 }, notes: '', createdAt: '', updatedAt: ''
  };
  const x2d: PrinterProfile = {
    ...base, nozzles: [
      { label: 'Main (direct drive)', feed: 'direct' },
      { label: 'Auxiliary (bowden)', feed: 'bowden' }
    ]
  };

  it('two declared nozzles is the only thing that earns dual-nozzle machinery', () => {
    const t = nozzleTopology(x2d);
    expect(t.kind).toBe('multi');
    expect(t.count).toBe(2);
    expect(t.perNozzle).toBe(true);
  });

  it('a single-nozzle profile is single, whatever the extruder count says', () => {
    expect(nozzleTopology(base).kind).toBe('single');
    expect(nozzleTopology(base).perNozzle).toBe(false);
    expect(nozzleTopology({ ...base, extruderCount: 1 }).kind).toBe('single');
    // A one-entry nozzle list is still one physical nozzle.
    const one = nozzleTopology({ ...base, nozzles: [{ label: 'Only nozzle', feed: 'direct' }] });
    expect(one.kind).toBe('single');
    expect(one.perNozzle).toBe(false);
  });

  it('several extruders but no nozzle list is UNKNOWN, not multi', () => {
    const t = nozzleTopology({ ...base, extruderCount: 3 });
    expect(t.kind).toBe('unknown');
    expect(t.perNozzle).toBe(false);
    expect(t.note).toBeTruthy();
    expect(t.note!.toLowerCase()).toContain('nozzle');
  });

  it('no printer at all claims nothing', () => {
    const t = nozzleTopology(undefined);
    expect(t.kind).toBe('unknown');
    expect(t.count).toBe(0);
    expect(t.perNozzle).toBe(false);
  });

  it('says so when the declared nozzles and the extruder count disagree', () => {
    const t = nozzleTopology({ ...x2d, extruderCount: 1 });
    expect(t.kind).toBe('multi'); // the nozzle list is the physical statement
    expect(t.note).toBeTruthy();
  });
});
