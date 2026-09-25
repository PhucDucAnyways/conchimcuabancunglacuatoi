import React, { useRef, useEffect, useState } from 'react';
import { StyleSheet, View, Text, AppState, TouchableOpacity } from 'react-native';
import { WebView } from 'react-native-webview';
import { viewerHtml } from '../generated/viewerHtml';

const source = { html: viewerHtml, baseUrl: 'https://memoryweaver.local' };
export default function RoomViewer3D({ room, textures, navMode = 'overview', onSelectFurniture, onRestrictedTouch, onPovChange, onNavModeChange, onNavWarning, cameraView }) {
  const webViewRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (!ready) return;
    const update = state => webViewRef.current?.injectJavaScript('window.setAppActive?.(' + (state === 'active') + '); true;');
    update(AppState.currentState || 'active');
    const subscription = AppState.addEventListener('change', update);
    return () => subscription.remove();
  }, [ready]);
  useEffect(() => {
    if (ready) webViewRef.current?.injectJavaScript('window.updateRoom(' + JSON.stringify(room) + '); true;');
  }, [room, ready]);
  useEffect(() => {
    if (ready) {
      webViewRef.current?.injectJavaScript('window.applyExtractedTextures?.(' + JSON.stringify(textures || {}) + '); true;');
    }
  }, [textures, room, ready]);
  useEffect(() => {
    if (ready && cameraView) {
      webViewRef.current?.injectJavaScript('window.setCameraView?.("' + cameraView + '"); true;');
    }
  }, [cameraView, ready]);
  useEffect(() => {
    if (ready && navMode) {
      webViewRef.current?.injectJavaScript('window.setNavMode?.("' + navMode + '"); true;');
    }
  }, [navMode, ready]);
  const handleMessage = event => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === 'READY') setReady(true);
      if (data.type === 'ERROR') setError(data.message);
      if (data.type === 'SELECT_FURNITURE') onSelectFurniture?.(data.label, data.description);
      if (data.type === 'RESTRICTED_TOUCH') onRestrictedTouch?.(data.label, data.dialogue);
      if (data.type === 'POV_STATE') onPovChange?.(data.mode, data.label);
      if (data.type === 'NAV_WARNING') onNavWarning?.(data.message);
      if (data.type === 'NAV_MODE_CHANGED') onNavModeChange?.(data.mode);
    } catch {}
  };
  return <View style={styles.container}>
    <WebView key={generation} ref={webViewRef} source={source} originWhitelist={['*']}
      onLoadStart={() => { setReady(false); setError(''); }} onMessage={handleMessage}
      onRenderProcessGone={() => { setReady(false); setError('Bộ hiển thị 3D đã dừng do thiếu tài nguyên. Hãy mở lại app.'); }}
      onContentProcessDidTerminate={() => { setReady(false); setError('Bộ hiển thị 3D đã dừng. Hãy mở lại app.'); }}
      onError={() => setError('Không tải được bộ hiển thị 3D. Hãy mở lại app.')}
      onShouldStartLoadWithRequest={request => request.url === 'about:blank' || request.url === source.baseUrl || request.url === source.baseUrl + '/'}
      javaScriptEnabled scrollEnabled={false} style={styles.container} />
    {!!error && <View style={styles.error}>
      <Text accessibilityRole="alert">{error}</Text>
      <TouchableOpacity accessibilityRole="button" accessibilityLabel="Tải lại bộ hiển thị 3D" style={styles.retry}
        onPress={() => { setReady(false); setError(''); setGeneration(value => value + 1); }}>
        <Text>Tải lại 3D</Text>
      </TouchableOpacity>
    </View>}
  </View>;
}
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#ffffff' },
  error: { position: 'absolute', top: 20, left: 20, right: 20, backgroundColor: '#ffffff', padding: 12, borderRadius: 8 },
  retry: { padding: 12, marginTop: 8, backgroundColor: '#d9eee3', borderRadius: 6 },
});
