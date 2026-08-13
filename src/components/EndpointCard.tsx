import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, spacing, typography } from '../constants/theme';
import { EndpointRecord, HealthStatus } from '../types/domain';
import { formatDate, formatDuration } from '../utils/text';
import { Card, Pill } from './Base';

export function EndpointCard({ endpoint, onPress }: { endpoint: EndpointRecord; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [{ opacity: pressed ? 0.86 : 1 }]}>
      <Card>
        <View style={styles.header}>
          <View style={{ flex: 1, gap: 5 }}>
            <Text style={styles.title}>{endpoint.name}</Text>
            <Text style={styles.host}>{endpoint.baseUrl}</Text>
          </View>
          <Pill label={endpoint.status.toUpperCase()} tone={statusTone(endpoint.status)} />
        </View>
        <View style={styles.metaLine}>
          <Pill label={endpoint.provider} tone="info" />
          {endpoint.demo ? <Pill label="DEMO" tone="neutral" /> : null}
          {endpoint.favorite ? <Pill label="FAVORITE" tone="good" /> : null}
        </View>
        <View style={styles.stats}>
          <Text style={styles.stat}>{endpoint.models.length} model{endpoint.models.length === 1 ? '' : 's'}</Text>
          <Text style={styles.dot}>•</Text>
          <Text style={styles.stat}>{formatDuration(endpoint.latencyMs)}</Text>
          <Text style={styles.dot}>•</Text>
          <Text style={styles.stat}>{formatDate(endpoint.lastSeenAt)}</Text>
        </View>
        {endpoint.error ? <Text style={styles.note}>{endpoint.error}</Text> : null}
      </Card>
    </Pressable>
  );
}

function statusTone(status: HealthStatus): 'good' | 'warn' | 'bad' | 'neutral' {
  if (status === 'healthy') return 'good';
  if (status === 'warning') return 'warn';
  if (status === 'offline') return 'bad';
  return 'neutral';
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
  title: { color: colors.text, fontSize: typography.h3, fontWeight: '900' },
  host: { color: colors.muted, fontSize: typography.small },
  metaLine: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  stats: { flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  stat: { color: colors.muted, fontSize: typography.small, fontWeight: '700' },
  dot: { color: colors.faint },
  note: { color: colors.yellow, fontSize: typography.small, lineHeight: 18 }
});
