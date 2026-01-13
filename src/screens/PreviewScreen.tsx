import React from 'react';
import { View, Image, StyleSheet } from 'react-native';
import type { StackScreenProps } from '@react-navigation/stack';
import type { RootStackParamList } from '../navigation/types';

type Props = StackScreenProps<RootStackParamList, 'Preview'>;

export function PreviewScreen({ route }: Props): React.ReactElement {
  return (
    <View style={styles.container}>
      <Image source={{ uri: route.params.uri }} style={styles.image} resizeMode='contain' />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  image: { width: '100%', height: '100%' },
});
