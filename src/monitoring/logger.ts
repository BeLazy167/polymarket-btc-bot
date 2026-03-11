import pino from 'pino'

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
})

// ANSI escape helpers
const esc = (code: string) => `\x1b[${code}m`
const reset = esc('0')

const c = {
  green: (s: string) => `${esc('32')}${s}${reset}`,
  red: (s: string) => `${esc('31')}${s}${reset}`,
  yellow: (s: string) => `${esc('33')}${s}${reset}`,
  cyan: (s: string) => `${esc('36')}${s}${reset}`,
  magenta: (s: string) => `${esc('35')}${s}${reset}`,
  dim: (s: string) => `${esc('2')}${s}${reset}`,
  bold: (s: string) => `${esc('1')}${s}${reset}`,
  bgGreen: (s: string) => `${esc('42;30')}${s}${reset}`,
  bgRed: (s: string) => `${esc('41;97')}${s}${reset}`,
  bgCyan: (s: string) => `${esc('46;30')}${s}${reset}`,
  bgYellow: (s: string) => `${esc('43;30')}${s}${reset}`,
  bgMagenta: (s: string) => `${esc('45;97')}${s}${reset}`,
}

/** Box-drawing characters */
const box = {
  tl: '╭', tr: '╮', bl: '╰', br: '╯',
  h: '─', v: '│',
  dot: '●', arrow: '▸', bar: '█', halfBar: '▌',
}

/** Sparkline from recent values */
const sparkChars = '▁▂▃▄▅▆▇█'
export function sparkline(values: number[]): string {
  if (values.length < 2) return ''
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  return values.map(v => sparkChars[Math.min(Math.floor(((v - min) / range) * 7), 7)]).join('')
}

/** Progress bar for time remaining */
export function progressBar(elapsed: number, total: number, width = 20): string {
  const pct = Math.min(elapsed / total, 1)
  const filled = Math.round(pct * width)
  const empty = width - filled
  const barColor = pct < 0.6 ? c.cyan : pct < 0.85 ? c.yellow : c.red
  return barColor(box.bar.repeat(filled)) + c.dim('░'.repeat(empty))
}

/** Colored one-liner to stdout for key events */
export function stdout(line: string) {
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false })
  console.log(`${c.dim(ts)} ${line}`)
}

/** Banner box for startup/shutdown */
export function banner(lines: string[], style: 'start' | 'stop' = 'start') {
  const maxLen = Math.max(...lines.map(l => stripAnsi(l).length))
  const pad = (s: string) => s + ' '.repeat(Math.max(0, maxLen - stripAnsi(s).length))
  const border = style === 'start' ? c.cyan : c.red
  const hr = box.h.repeat(maxLen + 2)

  console.log(border(`${box.tl}${hr}${box.tr}`))
  for (const line of lines) {
    console.log(`${border(box.v)} ${pad(line)} ${border(box.v)}`)
  }
  console.log(border(`${box.bl}${hr}${box.br}`))
}

/** Strip ANSI codes for length calculation */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

/** Tag badges for log categories */
export const tag = {
  trade: c.bgGreen(' TRADE '),
  sell: c.bgRed(' SELL '),
  signal: c.bgCyan(' SIGNAL '),
  market: c.bgMagenta(' MARKET '),
  warn: c.bgYellow(' WARN '),
  win: c.bgGreen(' WIN '),
  loss: c.bgRed(' LOSS '),
}

export const color = c
export { box }
