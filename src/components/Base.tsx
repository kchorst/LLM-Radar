import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, TextStyle, View, ViewStyle, StyleProp } from 'react-native';
import { colors, radius, spacing, typography } from '../constants/theme';

export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function SectionTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {subtitle ? <Text style={styles.subtle}>{subtitle}</Text> : null}
    </View>
  );
}

export function Button({ title, onPress, variant = 'primary', disabled, loading }: { title: string; onPress?: () => void; variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; disabled?: boolean; loading?: boolean }) {
  return (
    <Pressable onPress={disabled || loading ? undefined : onPress} style={({ pressed }) => [
      styles.button,
      variant === 'primary' && styles.buttonPrimary,
      variant === 'secondary' && styles.buttonSecondary,
      variant === 'ghost' && styles.buttonGhost,
      variant === 'danger' && styles.buttonDanger,
      (pressed && !disabled) && { opacity: 0.82 },
      disabled && styles.disabled
    ]}>
      {loading ? <ActivityIndicator size="small" color={variant === 'primary' ? colors.bg : colors.text} /> : <Text style={[styles.buttonText, variant === 'primary' && { color: colors.bg }]}>{title}</Text>}
    </Pressable>
  );
}

export function Pill({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info' }) {
  return <View style={[styles.pill, pillTone(tone)]}><Text style={[styles.pillText, pillTextTone(tone)]}>{label}</Text></View>;
}

export function Field({ label, value, onChangeText, placeholder, multiline, secureTextEntry }: { label: string; value: string; onChangeText: (v: string) => void; placeholder?: string; multiline?: boolean; secureTextEntry?: boolean }) {
  return (
    <View style={{ gap: 7 }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.faint}
        multiline={multiline}
        secureTextEntry={secureTextEntry}
        autoCapitalize="none"
        autoCorrect={false}
        style={[styles.input, multiline && { minHeight: 98, textAlignVertical: 'top' }]}
      />
    </View>
  );
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <Card style={{ alignItems: 'flex-start' }}>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.subtle}>{body}</Text>
    </Card>
  );
}

export function Metric({ label, value, tone = 'neutral' }: { label: string; value: string | number; tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info' }) {
  return (
    <View style={[styles.metric, pillTone(tone)]}>
      <Text style={styles.metricValue}>{value}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
  );
}

export function Row({ label, value, valueStyle }: { label: string; value: string; valueStyle?: TextStyle }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, valueStyle]}>{value}</Text>
    </View>
  );
}

function pillTone(tone: string): ViewStyle {
  if (tone === 'good') return { backgroundColor: colors.greenSoft, borderColor: 'rgba(145, 209, 139, 0.25)' };
  if (tone === 'warn') return { backgroundColor: colors.yellowSoft, borderColor: 'rgba(230, 195, 106, 0.25)' };
  if (tone === 'bad') return { backgroundColor: colors.redSoft, borderColor: 'rgba(240, 138, 138, 0.25)' };
  if (tone === 'info') return { backgroundColor: colors.blueSoft, borderColor: 'rgba(138, 180, 248, 0.25)' };
  return { backgroundColor: colors.panel3, borderColor: colors.border };
}

function pillTextTone(tone: string): TextStyle {
  if (tone === 'good') return { color: colors.green };
  if (tone === 'warn') return { color: colors.yellow };
  if (tone === 'bad') return { color: colors.red };
  if (tone === 'info') return { color: colors.blue };
  return { color: colors.muted };
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.panel,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.sm,
    padding: spacing.sm,
    gap: spacing.sm
  },
  sectionHeader: { gap: 3, marginTop: spacing.sm },
  sectionTitle: { color: colors.text, fontWeight: '800', fontSize: typography.h3 },
  subtle: { color: colors.muted, fontSize: typography.body, lineHeight: 19, fontWeight: '700' },
  label: { color: colors.muted, fontSize: typography.small, fontWeight: '800' },
  button: {
    minHeight: 36,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border
  },
  buttonPrimary: { backgroundColor: colors.accent, borderColor: colors.accent },
  buttonSecondary: { backgroundColor: colors.panel3, borderColor: colors.border },
  buttonGhost: { backgroundColor: colors.transparent, borderColor: colors.border },
  buttonDanger: { backgroundColor: colors.redSoft, borderColor: 'rgba(240, 138, 138, 0.25)' },
  buttonText: { color: colors.text, fontWeight: '900', fontSize: 11 },
  disabled: { opacity: 0.42 },
  pill: { alignSelf: 'flex-start', borderRadius: 999, borderWidth: 1, paddingVertical: 3, paddingHorizontal: 8 },
  pillText: { fontSize: typography.tiny, fontWeight: '800', letterSpacing: 0.2 },
  input: {
    backgroundColor: colors.panel2,
    borderColor: colors.border,
    borderWidth: 1,
    color: colors.text,
    borderRadius: radius.sm,
    padding: spacing.sm,
    fontSize: typography.body
  },
  emptyTitle: { color: colors.text, fontSize: typography.h3, fontWeight: '800' },
  metric: { flex: 1, minWidth: 84, borderRadius: radius.md, borderWidth: 1, padding: spacing.sm, gap: 3 },
  metricValue: { color: colors.text, fontSize: 20, fontWeight: '900' },
  metricLabel: { color: colors.muted, fontSize: typography.tiny, fontWeight: '800' },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm, paddingVertical: 5, borderBottomColor: 'rgba(255,255,255,0.08)', borderBottomWidth: 1 },
  rowLabel: { color: colors.muted, fontSize: typography.small, flex: 1, fontWeight: '700' },
  rowValue: { color: colors.text, fontSize: typography.small, flex: 1.4, textAlign: 'right', fontWeight: '700' }
});
