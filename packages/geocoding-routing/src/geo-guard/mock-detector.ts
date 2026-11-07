import { vincentyDistance } from './geofence';
import {
  CoordinatesInput,
  FraudRiskLevel,
  KinematicSample,
  MockDetectionInput,
  MockDetectionLayers,
  MockDetectionResult,
  MockDetectorOptions,
} from './schemas';

export const DEFAULT_MOCK_OPTIONS: MockDetectorOptions = {
  maxSpeedKmh: 150, // 150 km/h max threshold for salesperson on ground
  minAcceptableAccuracy: 0.01, // Sub-centimeter accuracy is physically impossible on mobile GPS
  minKinematicVariance: 0.001, // Hand tremor / sensor noise threshold (m/s^2)^2
  minKinematicSamples: 3,
};

/**
 * Layer 1: Check native OS mock provider flags (Android isFromMockProvider)
 */
export function checkMockProviderFlag(currentLocation: CoordinatesInput): {
  flagged: boolean;
  details: string;
} {
  const isMock = Boolean(
    currentLocation.isMockProvider ||
    currentLocation.isFromMockProvider
  );

  return {
    flagged: isMock,
    details: isMock
      ? 'Native OS mock provider flag detected (isMockProvider/isFromMockProvider = true)'
      : 'No native mock provider flag set',
  };
}

/**
 * Layer 2: Analyze GPS accuracy
 * - Real mobile hardware GPS has natural atmospheric/multipath noise (typically 3m - 30m).
 * - Exact 0.0m accuracy is physically impossible and indicates spoofed data injection.
 * - Negative, NaN, or sub-centimeter accuracy (< 0.01m) without RTK indicates simulated location.
 */
export function checkAccuracyAnomaly(
  currentLocation: CoordinatesInput,
  minAcceptableAccuracy: number = DEFAULT_MOCK_OPTIONS.minAcceptableAccuracy
): {
  flagged: boolean;
  details: string;
  accuracy?: number;
} {
  const accuracy = currentLocation.accuracy;

  if (accuracy === undefined) {
    return {
      flagged: false,
      details: 'Accuracy metric not provided in GPS fix',
    };
  }

  if (Number.isNaN(accuracy) || accuracy < 0) {
    return {
      flagged: true,
      details: `GPS accuracy is invalid or negative (${accuracy}m)`,
      accuracy,
    };
  }

  if (accuracy === 0) {
    return {
      flagged: true,
      details: 'GPS accuracy is exactly 0.0m (hardcoded mock coordinate signature)',
      accuracy,
    };
  }

  if (accuracy < minAcceptableAccuracy) {
    return {
      flagged: true,
      details: `GPS accuracy ${accuracy}m is unnaturally precise (< ${minAcceptableAccuracy}m) without RTK hardware`,
      accuracy,
    };
  }

  return {
    flagged: false,
    details: `GPS accuracy ${accuracy}m is within realistic mobile hardware bounds`,
    accuracy,
  };
}

/**
 * Parse various timestamp formats into milliseconds epoch
 */
function parseTimestampMs(ts?: number | string | Date): number | undefined {
  if (ts === undefined) return undefined;
  if (typeof ts === 'number') {
    // If in seconds (e.g. 10 digits), convert to ms
    return ts < 1e11 ? ts * 1000 : ts;
  }
  if (ts instanceof Date) {
    return ts.getTime();
  }
  const parsed = new Date(ts).getTime();
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Layer 3: Teleportation & Impossible Speed Check
 * Detects excessive ground speed (> 150 km/h) between two consecutive check-in pings
 */
export function checkTeleportation(
  currentLocation: CoordinatesInput,
  previousLocation?: CoordinatesInput,
  maxSpeedKmh: number = DEFAULT_MOCK_OPTIONS.maxSpeedKmh
): {
  flagged: boolean;
  details: string;
  calculatedSpeedKmh?: number;
  distanceMeters?: number;
  timeDeltaSeconds?: number;
} {
  if (!previousLocation) {
    return {
      flagged: false,
      details: 'No previous location supplied for teleportation comparison',
    };
  }

  const currentTs = parseTimestampMs(currentLocation.timestamp);
  const prevTs = parseTimestampMs(previousLocation.timestamp);

  if (!currentTs || !prevTs) {
    return {
      flagged: false,
      details: 'Missing timestamps required for velocity calculation',
    };
  }

  const timeDeltaSeconds = (currentTs - prevTs) / 1000;

  if (timeDeltaSeconds < 0) {
    return {
      flagged: true,
      details: `Inconsistent timestamp order: current time is earlier than previous check-in (${timeDeltaSeconds}s delta)`,
      timeDeltaSeconds,
    };
  }

  if (timeDeltaSeconds === 0) {
    // Same millisecond check-in
    const distanceMeters = vincentyDistance(previousLocation, currentLocation);
    if (distanceMeters > 50) {
      return {
        flagged: true,
        details: `Instantaneous jump of ${distanceMeters}m in 0 seconds (infinite velocity)`,
        distanceMeters,
        timeDeltaSeconds: 0,
        calculatedSpeedKmh: 9999,
      };
    }
    return {
      flagged: false,
      details: 'Consecutive check-in at same timestamp within static jitter radius',
      distanceMeters,
      timeDeltaSeconds: 0,
      calculatedSpeedKmh: 0,
    };
  }

  const distanceMeters = vincentyDistance(previousLocation, currentLocation);
  const distanceKm = distanceMeters / 1000;
  const timeHours = timeDeltaSeconds / 3600;
  const calculatedSpeedKmh = Math.round((distanceKm / timeHours) * 10) / 10;

  if (calculatedSpeedKmh > maxSpeedKmh) {
    return {
      flagged: true,
      details: `Impossible velocity detected: ${calculatedSpeedKmh} km/h (threshold: ${maxSpeedKmh} km/h). Traveled ${Math.round(distanceMeters)}m in ${Math.round(timeDeltaSeconds)}s`,
      calculatedSpeedKmh,
      distanceMeters,
      timeDeltaSeconds,
    };
  }

  return {
    flagged: false,
    details: `Velocity ${calculatedSpeedKmh} km/h is within realistic travel limits (threshold: ${maxSpeedKmh} km/h)`,
    calculatedSpeedKmh,
    distanceMeters,
    timeDeltaSeconds,
  };
}

/**
 * Layer 4: Kinematic Sensor Check (Hand tremor & motion heuristic)
 * Evaluates accelerometer readings to detect Android emulators or static fake GPS injections
 * Real humans holding a phone at a retail store exhibit natural physiological tremor (variance > 0)
 * Emulators on PC or mock scripts produce constant static readings (e.g. 0, 0, 9.81 or variance = 0)
 */
export function checkKinematicSensor(
  samples?: KinematicSample[],
  minVariance: number = DEFAULT_MOCK_OPTIONS.minKinematicVariance,
  minSamples: number = DEFAULT_MOCK_OPTIONS.minKinematicSamples
): {
  flagged: boolean;
  details: string;
  sampleCount: number;
  magnitudeVariance?: number;
  isEmulatorLikely: boolean;
} {
  if (!samples || samples.length === 0) {
    return {
      flagged: false,
      details: 'No accelerometer samples provided',
      sampleCount: 0,
      isEmulatorLikely: false,
    };
  }

  if (samples.length < minSamples) {
    return {
      flagged: false,
      details: `Insufficient accelerometer samples (${samples.length}/${minSamples}) for statistical analysis`,
      sampleCount: samples.length,
      isEmulatorLikely: false,
    };
  }

  // Calculate magnitudes: norm = sqrt(x^2 + y^2 + z^2)
  const magnitudes = samples.map(s => Math.sqrt(s.x * s.x + s.y * s.y + s.z * s.z));

  // Check if all samples are completely identical
  const first = samples[0];
  const allIdentical = samples.every(s => s.x === first.x && s.y === first.y && s.z === first.z);

  // Compute mean magnitude
  const meanMag = magnitudes.reduce((acc, val) => acc + val, 0) / magnitudes.length;

  // Compute variance of magnitude: sum((m - mean)^2) / N
  const variance =
    magnitudes.reduce((acc, val) => acc + Math.pow(val - meanMag, 2), 0) / magnitudes.length;

  // Compute per-axis variance
  const meanX = samples.reduce((acc, s) => acc + s.x, 0) / samples.length;
  const meanY = samples.reduce((acc, s) => acc + s.y, 0) / samples.length;
  const meanZ = samples.reduce((acc, s) => acc + s.z, 0) / samples.length;

  const varX = samples.reduce((acc, s) => acc + Math.pow(s.x - meanX, 2), 0) / samples.length;
  const varY = samples.reduce((acc, s) => acc + Math.pow(s.y - meanY, 2), 0) / samples.length;
  const varZ = samples.reduce((acc, s) => acc + Math.pow(s.z - meanZ, 2), 0) / samples.length;
  const totalAxisVariance = varX + varY + varZ;

  const isZeroOrNearZeroVariance = variance < minVariance && totalAxisVariance < minVariance;

  // Detect PC Emulator zero gravity signature (0,0,0) or static unmoving table/emulator
  const isZeroVector = Math.abs(meanMag) < 0.1;

  if (allIdentical || isZeroOrNearZeroVariance || isZeroVector) {
    return {
      flagged: true,
      details: `Static sensor signature detected (variance: ${variance.toFixed(6)}, axis variance: ${totalAxisVariance.toFixed(6)}). Characteristic of Android PC Emulator or injected mock sensor`,
      sampleCount: samples.length,
      magnitudeVariance: variance,
      isEmulatorLikely: true,
    };
  }

  return {
    flagged: false,
    details: `Natural human hand tremor verified (magnitude variance: ${variance.toFixed(5)} >= ${minVariance})`,
    sampleCount: samples.length,
    magnitudeVariance: variance,
    isEmulatorLikely: false,
  };
}

/**
 * 4-Layer Fake GPS Guard
 * Aggregates all 4 detection layers into a risk assessment score and verdict
 */
export function detectMockLocation(input: MockDetectionInput): MockDetectionResult {
  const options = { ...DEFAULT_MOCK_OPTIONS, ...input.options };

  const layerMockProvider = checkMockProviderFlag(input.currentLocation);
  const layerAccuracy = checkAccuracyAnomaly(
    input.currentLocation,
    options.minAcceptableAccuracy
  );
  const layerTeleportation = checkTeleportation(
    input.currentLocation,
    input.previousLocation,
    options.maxSpeedKmh
  );
  const layerKinematic = checkKinematicSensor(
    input.accelerometerSamples,
    options.minKinematicVariance,
    options.minKinematicSamples
  );

  const layers: MockDetectionLayers = {
    mockProvider: layerMockProvider,
    accuracyAnalysis: layerAccuracy,
    teleportation: layerTeleportation,
    kinematicCheck: layerKinematic,
  };

  const reasons: string[] = [];
  let threatScore = 0;

  // Layer 1 Scoring: Mock provider flag
  if (layerMockProvider.flagged) {
    threatScore += 50;
    reasons.push('MOCK_PROVIDER_FLAG_ACTIVE');
  }

  // Layer 2 Scoring: Accuracy anomaly
  if (layerAccuracy.flagged) {
    threatScore += 30;
    if (layerAccuracy.accuracy === 0) {
      reasons.push('GPS_ACCURACY_EXACTLY_ZERO');
    } else {
      reasons.push('GPS_ACCURACY_UNNATURAL');
    }
  }

  // Layer 3 Scoring: Teleportation
  if (layerTeleportation.flagged) {
    threatScore += 40;
    if ((layerTeleportation.calculatedSpeedKmh ?? 0) > 300) {
      threatScore += 10; // Extra penalty for supersonic/flight jump
    }
    reasons.push('TELEPORTATION_EXCESSIVE_SPEED');
  }

  // Layer 4 Scoring: Kinematic emulator check
  if (layerKinematic.flagged) {
    threatScore += 30;
    reasons.push('KINEMATIC_ZERO_VARIANCE_EMULATOR');
  }

  const clampedScore = Math.min(100, Math.max(0, threatScore));

  let riskLevel: FraudRiskLevel = 'LOW';
  if (clampedScore >= 75) {
    riskLevel = 'CRITICAL';
  } else if (clampedScore >= 45) {
    riskLevel = 'HIGH';
  } else if (clampedScore >= 20) {
    riskLevel = 'MEDIUM';
  } else {
    riskLevel = 'LOW';
  }

  // Final verdict: Flagged if score >= 40 OR any critical layer is triggered
  const isMock =
    clampedScore >= 40 ||
    layerMockProvider.flagged ||
    (layerAccuracy.flagged && layerAccuracy.accuracy === 0) ||
    layerTeleportation.flagged;

  return {
    isMock,
    threatScore: clampedScore,
    riskLevel,
    reasons,
    layers,
    evaluatedAt: new Date().toISOString(),
  };
}
