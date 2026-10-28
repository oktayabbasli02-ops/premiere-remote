// Maps the UXP runtime module names onto Adobe's published declarations.
declare module 'premierepro' {
  const ppro: import('@adobe/premierepro').premierepro;
  export = ppro;
}

declare module 'uxp' {
  export const storage: {
    secureStorage: {
      getItem(key: string): Promise<Uint8Array>;
      setItem(key: string, value: string | Uint8Array): Promise<void>;
    };
  };
}

declare function qrcode(typeNumber: number, errorCorrectionLevel: string): {
  addData(data: string): void;
  make(): void;
  getModuleCount(): number;
  isDark(row: number, col: number): boolean;
};
