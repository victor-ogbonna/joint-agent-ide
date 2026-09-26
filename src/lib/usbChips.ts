/**
 * The USB chip behind a board, from its USB vendor and product id.
 *
 * Every board reaches the computer or phone through a USB chip, and which one
 * decides how it behaves: an FTDI FT232R, a CH340 or a CP2102 are USB-serial
 * bridges with their own vendor protocols, while a genuine Uno or Mega carries
 * an ATmega16U2 running Arduino's firmware, which presents itself as a
 * standard (CDC-ACM) USB-serial device. That difference is why a phone can
 * leave one alone and take the other, so it is worth saying which it is.
 */
export function usbChipName(vendorId: number | undefined, productId: number | undefined): string | null {
  if (!vendorId) return null;
  const pid = productId ?? -1;
  switch (vendorId) {
    case 0x2341: // Arduino
    case 0x2a03: // Arduino (arduino.org era)
      if (pid === 0x0042 || pid === 0x0043 || pid === 0x0243 || pid === 0x0044) return "ATmega16U2";
      if (pid === 0x0010 || pid === 0x0001 || pid === 0x003f || pid === 0x003b) return "ATmega8U2";
      if (pid === 0x0036 || pid === 0x8036 || pid === 0x0037 || pid === 0x8037) return "ATmega32U4 (native USB)";
      return "Arduino USB";
    case 0x0403: // FTDI
      if (pid === 0x6001) return "FTDI FT232R";
      if (pid === 0x6015) return "FTDI FT231X";
      if (pid === 0x6014) return "FTDI FT232H";
      if (pid === 0x6010) return "FTDI FT2232";
      return "FTDI";
    case 0x1a86: // WCH
      if (pid === 0x55d4) return "CH9102";
      if (pid === 0x5523) return "CH341";
      return "CH340";
    case 0x10c4: // Silicon Labs
      if (pid === 0xea70) return "CP2105";
      if (pid === 0xea71) return "CP2108";
      return "CP2102";
    case 0x303a: // Espressif
      return "ESP32 native USB";
    default:
      return null;
  }
}

/** "0x2341:0x0042" */
export function usbId(vendorId: number | undefined, productId: number | undefined): string {
  const hex = (n: number | undefined) => `0x${(n ?? 0).toString(16).padStart(4, "0")}`;
  return `${hex(vendorId)}:${hex(productId)}`;
}
