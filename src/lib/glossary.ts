/**
 * What each chart series means, shown in the hover tooltip of its legend
 * entry in the Process total and Component charts (`data-term="<key>"`) — in the app (TermTooltip) and in the
 * standalone HTML report, which embeds this table in its data block.
 */
export interface GlossaryEntry {
  /** Name as shown, expanded where it is an abbreviation. */
  title: string;
  /** Plain-language meaning. */
  body: string;
  /** Where the value comes from. */
  source?: string;
}

export const GLOSSARY = {
  rss: {
    title: 'RSS — Resident Set Size',
    body:
      'Memory of this process currently held in RAM. Shared pages (libraries, shared memory) are counted in full ' +
      'for every process that maps them, so RSS of several processes overlaps and over-states the real cost.',
    source: 'smaps: Rss · status: VmRSS',
  },
  pss: {
    title: 'PSS — Proportional Set Size',
    body:
      'RSS with each shared page divided by the number of processes sharing it. PSS of all processes adds up ' +
      'to the RAM actually in use, which makes it the fairest single figure for what this process costs.',
    source: 'smaps: Pss',
  },
  private: {
    title: 'Private (USS — Unique Set Size)',
    body:
      'Pages in RAM that only this process maps: Private_Clean + Private_Dirty. Roughly what would be freed ' +
      'if the process exited. A steady rise here is the usual sign of a leak.',
    source: 'smaps: Private_Clean + Private_Dirty',
  },
  swap: {
    title: 'Swap',
    body:
      'Pages of this process moved out of RAM to swap (disk or zram). They no longer count in RSS but come back, ' +
      'slowly, when touched.',
    source: 'smaps: Swap · status: VmSwap',
  },
} satisfies Record<string, GlossaryEntry>;

export type GlossaryKey = keyof typeof GLOSSARY;
