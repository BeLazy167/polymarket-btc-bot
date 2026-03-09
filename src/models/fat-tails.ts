import { studentTCDF } from './math.ts'
import type { FairValueResult } from './types.ts'

/** Student-t(nu) + EWMA: FV_UP = 1 - F_{t,nu}(ln(K/S) / (sigma*sqrt(T))) */
export function fatTailsFairValue(
  S: number,
  K: number,
  T: number,
  sigma: number,
  nu: number = 7,
): FairValueResult {
  const z = Math.log(K / S) / (sigma * Math.sqrt(T))
  const fairValueUp = 1 - studentTCDF(z, nu)

  return {
    fairValueUp,
    fairValueDown: 1 - fairValueUp,
    sigma,
    model: 'fat-tails',
  }
}
