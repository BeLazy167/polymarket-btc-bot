import { normalCDF } from './math.ts'
import type { FairValueResult } from './types.ts'

/** Lognormal model using GARCH-estimated sigma for volatility input. */
export function garchFairValue(S: number, K: number, T: number, sigma: number): FairValueResult {
  const d = (Math.log(S / K) - 0.5 * sigma * sigma * T) / (sigma * Math.sqrt(T))
  const fairValueUp = normalCDF(d)

  return {
    fairValueUp,
    fairValueDown: 1 - fairValueUp,
    sigma,
    model: 'garch',
  }
}
