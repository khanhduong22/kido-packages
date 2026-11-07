import { haversineDistance, CoordinatesInput } from './haversine';
import { AirportFixedRoute, AirportHub } from './schemas';

export const VIETNAM_AIRPORTS: AirportHub[] = [
  {
    code: 'HAN',
    name: 'Sân bay Quốc tế Nội Bài',
    shortName: 'Nội Bài (Hà Nội)',
    city: 'Hà Nội',
    province: 'Hà Nội',
    coordinates: { lat: 21.2212, lon: 105.8072 },
    isMajor: true,
  },
  {
    code: 'SGN',
    name: 'Sân bay Quốc tế Tân Sơn Nhất',
    shortName: 'Tân Sơn Nhất (TP.HCM)',
    city: 'TP. Hồ Chí Minh',
    province: 'TP. Hồ Chí Minh',
    coordinates: { lat: 10.8188, lon: 106.6519 },
    isMajor: true,
  },
  {
    code: 'DAD',
    name: 'Sân bay Quốc tế Đà Nẵng',
    shortName: 'Đà Nẵng',
    city: 'Đà Nẵng',
    province: 'Đà Nẵng',
    coordinates: { lat: 16.0439, lon: 108.1994 },
    isMajor: true,
  },
  {
    code: 'CXR',
    name: 'Sân bay Quốc tế Cam Ranh',
    shortName: 'Cam Ranh (Nha Trang)',
    city: 'Nha Trang',
    province: 'Khánh Hòa',
    coordinates: { lat: 11.9981, lon: 109.2194 },
    isMajor: true,
  },
  {
    code: 'PQC',
    name: 'Sân bay Quốc tế Phú Quốc',
    shortName: 'Phú Quốc',
    city: 'Phú Quốc',
    province: 'Kiên Giang',
    coordinates: { lat: 10.1698, lon: 103.9931 },
    isMajor: true,
  },
  {
    code: 'HPH',
    name: 'Sân bay Quốc tế Cát Bi',
    shortName: 'Cát Bi (Hải Phòng)',
    city: 'Hải Phòng',
    province: 'Hải Phòng',
    coordinates: { lat: 20.8193, lon: 106.7249 },
    isMajor: true,
  },
  {
    code: 'DLI',
    name: 'Sân bay Liên Khương',
    shortName: 'Liên Khương (Đà Lạt)',
    city: 'Đà Lạt',
    province: 'Lâm Đồng',
    coordinates: { lat: 11.7506, lon: 108.3739 },
    isMajor: true,
  },
];

export const AIRPORT_FIXED_ROUTES: AirportFixedRoute[] = [
  {
    id: 'HAN-HN-CENTER',
    airportCode: 'HAN',
    name: 'Hà Nội Nội Thành ⇄ Sân bay Nội Bài',
    destinationName: 'Trung tâm Hà Nội (Hoàn Kiếm / Cầu Giấy / Ba Đình)',
    destinationCoordinates: { lat: 21.0285, lon: 105.8542 }, // Hồ Hoàn Kiếm
    distanceKm: 30,
    estimatedMinutes: 40,
    fares: {
      SEDAN_4: 220000,
      SUV_7: 260000,
      VIP_CARNIVAL: 450000,
    },
    description: 'Trọn gói cầu đường, đưa đón tận sảnh ga T1/T2 Nội Bài',
  },
  {
    id: 'SGN-Q1-CENTER',
    airportCode: 'SGN',
    name: 'TP.HCM Trung Tâm ⇄ Sân bay Tân Sơn Nhất',
    destinationName: 'Quận 1 / Quận 3 / TP. Hồ Chí Minh',
    destinationCoordinates: { lat: 10.7769, lon: 106.7009 }, // Chợ Bến Thành
    distanceKm: 8.5,
    estimatedMinutes: 30,
    fares: {
      SEDAN_4: 180000,
      SUV_7: 220000,
      VIP_CARNIVAL: 380000,
    },
    description: 'Đón tận sảnh Ga Quốc Nội/Quốc Tế, không lo chờ xe',
  },
  {
    id: 'DAD-HOIAN',
    airportCode: 'DAD',
    name: 'Sân bay Đà Nẵng ⇄ Phố cổ Hội An',
    destinationName: 'Phố cổ Hội An (Quảng Nam)',
    destinationCoordinates: { lat: 15.8801, lon: 108.338 }, // Hội An
    distanceKm: 30,
    estimatedMinutes: 45,
    fares: {
      SEDAN_4: 250000,
      SUV_7: 320000,
      VIP_CARNIVAL: 550000,
    },
    description: 'Chuyến xe du lịch nghỉ dưỡng trọn gói Đà Nẵng - Hội An',
  },
  {
    id: 'CXR-NTR',
    airportCode: 'CXR',
    name: 'Sân bay Cam Ranh ⇄ Trung tâm Nha Trang',
    destinationName: 'Thành phố Nha Trang (Đường Trần Phú)',
    destinationCoordinates: { lat: 12.2388, lon: 109.1967 }, // Trần Phú Nha Trang
    distanceKm: 35,
    estimatedMinutes: 45,
    fares: {
      SEDAN_4: 250000,
      SUV_7: 300000,
      VIP_CARNIVAL: 550000,
    },
    description: 'Đón tiễn Cam Ranh - Nha Trang xe đời mới máy lạnh êm ái',
  },
  {
    id: 'PQC-DUONGDONG',
    airportCode: 'PQC',
    name: 'Sân bay Phú Quốc ⇄ Thị trấn Dương Đông',
    destinationName: 'Thị trấn Dương Đông (Phú Quốc)',
    destinationCoordinates: { lat: 10.222, lon: 103.9631 },
    distanceKm: 12,
    estimatedMinutes: 20,
    fares: {
      SEDAN_4: 160000,
      SUV_7: 200000,
      VIP_CARNIVAL: 350000,
    },
    description: 'Đưa đón khách sạn resort Dương Đông - Phú Quốc',
  },
  {
    id: 'HPH-CENTER',
    airportCode: 'HPH',
    name: 'Sân bay Cát Bi ⇄ Trung tâm Hải Phòng',
    destinationName: 'Nhà hát lớn Hải Phòng / Trung tâm TP',
    destinationCoordinates: { lat: 20.8587, lon: 106.6806 },
    distanceKm: 8,
    estimatedMinutes: 20,
    fares: {
      SEDAN_4: 150000,
      SUV_7: 190000,
      VIP_CARNIVAL: 350000,
    },
    description: 'Đón trả ga Cát Bi nhanh chóng chuyên nghiệp',
  },
  {
    id: 'DLI-DALAT',
    airportCode: 'DLI',
    name: 'Sân bay Liên Khương ⇄ Trung tâm Đà Lạt',
    destinationName: 'Hồ Xuân Hương / Chợ Đà Lạt',
    destinationCoordinates: { lat: 11.9404, lon: 108.4583 },
    distanceKm: 30,
    estimatedMinutes: 45,
    fares: {
      SEDAN_4: 250000,
      SUV_7: 300000,
      VIP_CARNIVAL: 550000,
    },
    description: 'Đường đèo Prenn an toàn, tài xế bản địa giàu kinh nghiệm',
  },
];

export function getAllAirports(): AirportHub[] {
  return VIETNAM_AIRPORTS;
}

export function getAirportByCode(code: string): AirportHub | undefined {
  return VIETNAM_AIRPORTS.find((a) => a.code.toUpperCase() === code.trim().toUpperCase());
}

export function getAllFixedRoutes(): AirportFixedRoute[] {
  return AIRPORT_FIXED_ROUTES;
}

export function getFixedRouteById(id: string): AirportFixedRoute | undefined {
  return AIRPORT_FIXED_ROUTES.find((r) => r.id.toLowerCase() === id.trim().toLowerCase());
}

/**
 * Finds matching airport fixed route if origin or destination is close to an airport hub
 * and the counterpart is close to the route destination (within threshold km)
 */
export function findMatchingAirportRoute(
  origin: CoordinatesInput,
  destination: CoordinatesInput,
  airportThresholdKm = 8,
  destinationThresholdKm = 10
): AirportFixedRoute | undefined {
  for (const route of AIRPORT_FIXED_ROUTES) {
    const airport = getAirportByCode(route.airportCode);
    if (!airport) continue;

    // Case 1: Origin is Airport, Destination is City Center
    const originToAirport = haversineDistance(origin, airport.coordinates);
    const destToCity = haversineDistance(destination, route.destinationCoordinates);
    if (originToAirport <= airportThresholdKm && destToCity <= destinationThresholdKm) {
      return route;
    }

    // Case 2: Origin is City Center, Destination is Airport
    const originToCity = haversineDistance(origin, route.destinationCoordinates);
    const destToAirport = haversineDistance(destination, airport.coordinates);
    if (originToCity <= destinationThresholdKm && destToAirport <= airportThresholdKm) {
      return route;
    }
  }

  return undefined;
}
