import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { StackScreenProps } from '@react-navigation/stack';
import type { RootStackParamList } from '../navigation/types';

type Props = StackScreenProps<RootStackParamList, 'Preview'>;

export function PreviewScreen({ route }: Props): React.ReactElement {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Preview</Text>
      <Text style={styles.uri}>{route.params.uri}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 8 },
  title: { fontSize: 18, fontWeight: '700' },
  uri: { fontSize: 12 },
});
