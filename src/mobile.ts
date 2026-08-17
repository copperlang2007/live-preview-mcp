import QRCode from 'qrcode';

export async function generateQRCode(url: string): Promise<string> {
  try {
    return await QRCode.toDataURL(url, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 300,
      color: { dark: '#000000', light: '#ffffff' },
    });
  } catch (err) {
    throw new Error(`QR generation failed: ${(err as Error).message}`);
  }
}

export function extractExpoUrl(logs: string[]): string | undefined {
  for (const line of logs) {
    const match = line.match(/(exp:\/\/[^\s]+)/);
    if (match) return match[1];
    const match2 = line.match(/(https?:\/\/exp\.host\/[^\s]+)/);
    if (match2) return match2[1];
  }
  return undefined;
}
