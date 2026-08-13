import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius, spacing, typography } from '../constants/theme';

export type TabKey = 'dashboard' | 'chat' | 'rag' | 'library' | 'more' | 'wizard' | 'service' | 'discovery' | 'manual' | 'qr' | 'benchmark' | 'reports' | 'settings';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'dashboard', label: 'Home' },
  { key: 'chat', label: 'Chat' },
  { key: 'rag', label: 'Files' },
  { key: 'more', label: 'More' }
];

export function TabBar({ active, setActive, enabled }: { active: TabKey; setActive: (tab: TabKey) => void; enabled: Partial<Record<TabKey, boolean>> }) {
  return (
    <View style={styles.wrap}>
      {TABS.map(tab => {
        const isActive = tab.key === active;
        const isEnabled = enabled[tab.key] !== false;
        return (
          <Pressable key={tab.key} hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }} onPress={() => isEnabled && setActive(tab.key)} style={[styles.tab, isActive && styles.active, !isEnabled && styles.disabled]}>
            <Text style={[styles.label, isActive && styles.activeLabel]}>{tab.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    gap: 4,
    paddingHorizontal: 6,
    paddingTop: 6,
    paddingBottom: Platform.OS === 'android' ? 14 : 8,
    marginHorizontal: 10,
    marginBottom: Platform.OS === 'android' ? 42 : 10,
    borderRadius: radius.lg,
    backgroundColor: colors.panel2,
    borderWidth: 1,
    borderColor: colors.border,
    zIndex: 50,
    elevation: 12
  },
  tab: { flex: 1, minHeight: 48, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xs, borderWidth: 1, borderColor: 'transparent' },
  active: { backgroundColor: colors.accentSoft, borderColor: colors.accent, borderWidth: 1 },
  disabled: { opacity: 0.32 },
  label: { color: colors.muted, fontSize: typography.small, fontWeight: '900' },
  activeLabel: { color: colors.accent }
});
