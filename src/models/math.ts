/**
 * Standard normal CDF using Abramowitz & Stegun approximation (formula 26.2.17).
 * Maximum absolute error: 7.5e-8.
 *
 * @param x - The z-score.
 * @returns Cumulative probability P(Z <= x).
 */
export function normalCDF(x: number): number {
  const a1 = 0.254829592
  const a2 = -0.284496736
  const a3 = 1.421413741
  const a4 = -1.453152027
  const a5 = 1.061405429
  const p = 0.3275911

  const sign = x < 0 ? -1 : 1
  const absX = Math.abs(x)
  const t = 1.0 / (1.0 + p * absX)
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX / 2)

  return 0.5 * (1.0 + sign * y)
}

/**
 * Standard normal PDF.
 *
 * @param x - The z-score.
 * @returns Density f(x) = (1/sqrt(2pi)) * exp(-x^2/2).
 */
export function normalPDF(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI)
}

/**
 * Regularized incomplete beta function I_x(a, b) using the continued fraction
 * expansion (Lentz's method). Used internally by studentTCDF.
 *
 * Reference: Numerical Recipes, section 6.4.
 *
 * @param x - Upper integration limit, 0 <= x <= 1.
 * @param a - Shape parameter a > 0.
 * @param b - Shape parameter b > 0.
 * @returns The regularized incomplete beta I_x(a, b).
 */
export function betaIncomplete(x: number, a: number, b: number): number {
  if (x === 0) return 0
  if (x === 1) return 1

  const lnBeta = lgamma(a) + lgamma(b) - lgamma(a + b)
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lnBeta)

  // Use symmetry relation when x > (a+1)/(a+b+2) for better convergence
  if (x > (a + 1) / (a + b + 2)) {
    return 1 - betaIncomplete(1 - x, b, a)
  }

  return front * betaCF(x, a, b) / a
}

/**
 * Continued fraction expansion for the incomplete beta function
 * using the modified Lentz method.
 */
function betaCF(x: number, a: number, b: number): number {
  const maxIter = 200
  const eps = 3e-12
  const fpmin = 1e-30

  let qab = a + b
  let qap = a + 1
  let qam = a - 1
  let c = 1.0
  let d = 1.0 - qab * x / qap
  if (Math.abs(d) < fpmin) d = fpmin
  d = 1.0 / d
  let h = d

  for (let m = 1; m <= maxIter; m++) {
    const m2 = 2 * m

    // Even step
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2))
    d = 1.0 + aa * d
    if (Math.abs(d) < fpmin) d = fpmin
    c = 1.0 + aa / c
    if (Math.abs(c) < fpmin) c = fpmin
    d = 1.0 / d
    h *= d * c

    // Odd step
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
    d = 1.0 + aa * d
    if (Math.abs(d) < fpmin) d = fpmin
    c = 1.0 + aa / c
    if (Math.abs(c) < fpmin) c = fpmin
    d = 1.0 / d
    const del = d * c
    h *= del

    if (Math.abs(del - 1.0) < eps) break
  }

  return h
}

/**
 * Log-gamma function using the Lanczos approximation (g=7, n=9 coefficients).
 */
function lgamma(x: number): number {
  const cof = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
  ]

  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x)
  }

  x -= 1
  let a = cof[0]!
  const t = x + 7.5
  for (let i = 1; i < 9; i++) {
    a += cof[i]! / (x + i)
  }

  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a)
}

/**
 * Student's t-distribution CDF via the regularized incomplete beta function.
 *
 * Uses the identity: F_t(x; nu) = 1 - 0.5 * I_{nu/(nu+x^2)}(nu/2, 1/2)
 * for x >= 0, with symmetry for x < 0.
 *
 * @param x - The t-statistic.
 * @param nu - Degrees of freedom (nu > 0).
 * @returns Cumulative probability P(T <= x).
 */
export function studentTCDF(x: number, nu: number): number {
  const xt = nu / (nu + x * x)
  const ib = betaIncomplete(xt, nu / 2, 0.5)
  const cdf = 1 - 0.5 * ib

  return x >= 0 ? cdf : 1 - cdf
}

/**
 * EWMA variance update: sigma^2_t = lambda * prevVariance + (1 - lambda) * r^2.
 *
 * @param prevVariance - Previous variance estimate.
 * @param newReturn - Latest log return.
 * @param lambda - Decay factor, default 0.94 (RiskMetrics).
 * @returns Updated variance estimate.
 */
export function ewmaVariance(prevVariance: number, newReturn: number, lambda: number = 0.94): number {
  return lambda * prevVariance + (1 - lambda) * newReturn * newReturn
}

/**
 * GARCH(1,1) variance update: sigma^2_t = omega + alpha * r^2_{t-1} + beta * sigma^2_{t-1}.
 *
 * @param prevVariance - Previous conditional variance.
 * @param prevReturn - Previous log return.
 * @param omega - Long-run variance weight.
 * @param alpha - Shock coefficient.
 * @param beta - Persistence coefficient.
 * @returns Updated conditional variance.
 */
export function garchVariance(
  prevVariance: number,
  prevReturn: number,
  omega: number,
  alpha: number,
  beta: number,
): number {
  return omega + alpha * prevReturn * prevReturn + beta * prevVariance
}
