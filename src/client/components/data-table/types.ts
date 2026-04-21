export type ColumnPin = 'left' | 'right' | false;

export interface ColumnConfig {
  id: string;
  label: string;
  visible: boolean;
  pinned: ColumnPin;
  fixed?: boolean;
  group?: string;
}

export type TableDensity = 'compact' | 'normal' | 'comfortable';

export interface TablePreferences {
  columns: ColumnConfig[];
  density: TableDensity;
  presets?: Record<string, { columns: ColumnConfig[]; density: TableDensity }>;
  activePreset?: string;
}

export const DENSITY_ROW_HEIGHT: Record<TableDensity, number> = {
  compact: 32,
  normal: 36,
  comfortable: 44,
};
