import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StatusBar,
  Modal,
  Image,
  KeyboardAvoidingView,
  Platform,
  Alert
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ImagePicker from 'expo-image-picker';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import * as SecureStore from 'expo-secure-store';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { requestRoom, validEndpoint, requestDiagnosis, extractTextures } from './lib/room-api';
import RoomViewer3D from './components/RoomViewer3D';

const DEFAULT_APP_TOKEN = '';
const DEFAULT_REMOTE_ENDPOINT = typeof process !== 'undefined' ? (process.env?.EXPO_PUBLIC_API_URL || '') : '';

const SUGGESTIONS = [
  'Phòng khách ấm cúng có sofa và đèn cây',
  'Phòng đọc sách vintage bàn gỗ và kệ sách',
  'Phòng ngủ hiện đại tối giản phong cách Bắc Âu',
  'Góc làm việc sáng sủa cạnh cửa sổ lớn'
];

const CAREGIVER_SUGGESTIONS = [];

export default function App() {
  const [messages, setMessages] = useState([
    {
      id: '1',
      author: 'MemoryWeaver',
      text: 'Mô tả căn phòng hoặc chọn ảnh rồi bấm Gửi. AI tạo bản phác thảo 3D, không phải phục dựng chính xác. Phần ước đoán sẽ được ghi rõ khi chạm vào đồ vật.',
      isUser: false,
    }
  ]);
  const [inputText, setInputText] = useState('');
  const [selectedImage, setSelectedImage] = useState(null); // base64 string
  const [imageUri, setImageUri] = useState(null);
  const [currentRoom, setCurrentRoom] = useState(null);
  const [navMode, setNavMode] = useState('overview');
  const [textures, setTextures] = useState(null);
  const [usePhotoTexture, setUsePhotoTexture] = useState(false);
  const [roomTitle, setRoomTitle] = useState('KHÔNG GIAN CỦA BẠN');
  const [cameraView, setCameraView] = useState('isometric');
  const [povMode, setPovMode] = useState('overview'); // 'overview' | 'focused'
  const [focusedLabel, setFocusedLabel] = useState('');
  const [status, setStatus] = useState('Sẵn sàng • Chữ + ảnh');
  const [isBusy, setIsBusy] = useState(false);
  const [isPicking, setIsPicking] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const pickingRef = useRef(false);


  // Settings
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [serverEndpoint, setServerEndpoint] = useState('');
  const [appToken, setAppToken] = useState('');
  const [inputEndpoint, setInputEndpoint] = useState('');
  const [inputToken, setInputToken] = useState('');

  const scrollViewRef = useRef(null);
  const abortControllerRef = useRef(null);

  useEffect(() => {
    loadSettings();
    return () => abortControllerRef.current?.abort();
  }, []);

  const loadDiagnosis = async () => {
    try {
      if (!serverEndpoint) throw new Error('Hãy lưu địa chỉ server trước.');
      const result = await requestDiagnosis({ endpoint: serverEndpoint, signal: AbortSignal.timeout(15000) });
      Alert.alert('Khả năng xử lý hiện tại', result.modules.map(m => `${m.name}: ${m.status}\n${m.description}`).join('\n\n'));
    } catch (error) { Alert.alert('Không kiểm tra được', error.message); }
  };

  const loadSettings = async () => {
    try {
      const savedEndpoint = await AsyncStorage.getItem('mw_server_endpoint');
      const savedToken = await SecureStore.getItemAsync('mw_app_token');
      await AsyncStorage.removeItem('mw_app_token');

      let effectiveEndpoint = DEFAULT_REMOTE_ENDPOINT;
      if (savedEndpoint && validEndpoint(savedEndpoint)) {
        effectiveEndpoint = savedEndpoint;
      }

      setServerEndpoint(effectiveEndpoint);
      setAppToken(savedToken || DEFAULT_APP_TOKEN);
    } catch (e) {
      setServerEndpoint(DEFAULT_REMOTE_ENDPOINT);
      setAppToken(DEFAULT_APP_TOKEN);
    }
  };

  const openSettings = () => {
    setInputEndpoint(serverEndpoint || DEFAULT_REMOTE_ENDPOINT);
    setInputToken(appToken || DEFAULT_APP_TOKEN);
    setSettingsVisible(true);
  };

  const saveSettings = async () => {
    let ep = inputEndpoint.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(ep)) {
      ep = `http://${ep}`;
    }
    if (!validEndpoint(ep)) {
      Alert.alert('Lỗi', 'Dùng URL HTTPS của backend cloud. HTTP chỉ dành cho IP mạng nội bộ khi cần thử nghiệm.');
      return;
    }
    const probe = new AbortController();
    const probeTimer = setTimeout(() => probe.abort(), 15000);
    try {
      const response = await fetch(`${ep}/api/connection`, { signal: probe.signal,
        headers: { Authorization: `Bearer ${inputToken.trim()}` } });
      const health = await response.json();
      if (response.status === 401) throw new Error('APP_ACCESS_TOKEN chưa đúng. Sao chép token của server đang chạy.');
      if (!response.ok || health.provider !== 'gemini') throw new Error('Sai server hoặc server chưa cập nhật Gemini.');
      if (health.contractVersion !== 2) throw new Error('Server cũ không tương thích. Hãy chạy server trong thư mục MemoryWeaver.');
      if (!health.configured) throw new Error('Server chưa có khóa Gemini.');
    } catch (error) {
      Alert.alert('Chưa lưu kết nối', `Không xác nhận được server ${ep}. Mở ${ep}/health trên Chrome điện thoại để kiểm tra.\n${error.message}`);
      return;
    } finally { clearTimeout(probeTimer); }
    try {
      await SecureStore.setItemAsync('mw_app_token', inputToken.trim());
      await AsyncStorage.setItem('mw_server_endpoint', ep);
    } catch (e) { Alert.alert('Chưa lưu cài đặt', 'Không ghi được cấu hình trên thiết bị. Hãy thử lại.'); return; }
    setServerEndpoint(ep);
    setAppToken(inputToken.trim());
    setSettingsVisible(false);
    setStatus('Đã lưu kết nối server');
  };

  const pickImage = async () => {
    if (abortControllerRef.current || pickingRef.current) return;
    pickingRef.current = true; setIsPicking(true);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: false,
        quality: 0.8,
        base64: false,
      });

      if (!result.canceled && result.assets && result.assets.length > 0) {
        const asset = result.assets[0];
        const context = ImageManipulator.manipulate(asset.uri);
        if (Math.max(asset.width, asset.height) > 1280) {
          context.resize(asset.width >= asset.height ? { width: 1280 } : { height: 1280 });
        }
        let rendered;
        let image;
        try {
          rendered = await context.renderAsync();
          image = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: .8, base64: true });
        } finally { rendered?.release(); context.release(); }
        if (!image.base64 || image.base64.length > 5_300_000) throw new Error('Ảnh quá lớn, hãy chọn ảnh nhỏ hơn.');
        setSelectedImage(image.base64);
        setImageUri(image.uri);
      }
    } catch (err) {
      Alert.alert('Lỗi', 'Không mở được thư viện ảnh: ' + err.message);
    } finally {
      pickingRef.current = false; setIsPicking(false);
    }
  };

  const clearImage = () => {
    setSelectedImage(null);
    setImageUri(null);
  };

  const resetRoom = () => {
    if (pickingRef.current) return;
    if (abortControllerRef.current) {
      Alert.alert('Thông báo', 'Hãy hủy yêu cầu đang chạy trước khi làm mới.');
      return;
    }
    setNavMode('overview');
    setTextures(null);
    setCurrentRoom(null);
    setRoomTitle('KHÔNG GIAN CỦA BẠN');
    setCameraView('isometric');
    clearImage();
    setInputText('');
    setMessages([
      {
        id: Date.now().toString(),
        author: 'MemoryWeaver',
        text: 'Một khởi đầu mới. Bạn muốn tạo căn phòng nào?',
        isUser: false,
      }
    ]);
    setStatus('Đã làm mới không gian');
  };

  const handleSendOrCancel = () => {
    if (pickingRef.current) return;
    if (abortControllerRef.current) {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      return;
    }

    if (!inputText.trim() && !selectedImage) {
      Alert.alert('Nhắc nhở', 'Hãy nhập mô tả hoặc chọn một bức ảnh trước khi gửi.');
      return;
    }

    sendMessage();
  };

  const sendMessage = async () => {
    const prompt = inputText.trim();
    const imagePayload = selectedImage;
    const userMsg = {
      id: Date.now().toString(),
      author: 'Bạn',
      text: prompt + (imagePayload ? '\n[Đã đính kèm ảnh]' : ''),
      isUser: true,
    };

    setMessages(prev => [...prev.slice(-39), userMsg]);
    setIsBusy(true);
    setStatus('AI đang thiết kế căn phòng…');

    const controller = new AbortController();
    abortControllerRef.current = controller;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 165000);

    const primaryEp = serverEndpoint;
    const tokenToUse = appToken || DEFAULT_APP_TOKEN;

    try {
      if (!primaryEp) throw new Error('Hãy nhập địa chỉ server và token trong Cài đặt. Nội dung của bạn được giữ để gửi lại.');
      const data = await requestRoom({ endpoint: primaryEp, token: tokenToUse,
        prompt, image: imagePayload, previousRoom: currentRoom, signal: controller.signal });
      if (controller.signal.aborted) throw Object.assign(new Error(), { name: 'AbortError' });
      setInputText('');
      clearImage();

      if (imagePayload) setTextures(null);
      // Success
      setCurrentRoom(data);
      setRoomTitle(data.title || 'CĂN PHÒNG KÝ ỨC');
      setMessages(prev => [
        ...prev.slice(-39),
        {
          id: (Date.now() + 1).toString(),
          author: 'MemoryWeaver',
          text: data.reply || 'Căn phòng đã được tạo thành công.',
          isUser: false,
        }
      ]);
      setStatus('Đã dựng bản phác thảo 3D • Chạm đồ vật để xem nguồn thông tin');
      if (usePhotoTexture && imagePayload) {
        setStatus('Phòng đã sẵn sàng • Đang lấy texture ảnh…');
        try {
          const textureResult = await extractTextures({ endpoint: primaryEp, token: tokenToUse, image: imagePayload, signal: controller.signal });
          if (!controller.signal.aborted) { setTextures(textureResult.textures); setStatus('Đã áp texture ước lượng từ ảnh • Có thể không khớp thực tế'); }
        } catch {
          setStatus('Phòng đã sẵn sàng • Chưa áp được texture, đang dùng vật liệu mặc định');
        }
      }

    } catch (err) {
      let errMsg = err.name === 'AbortError'
        ? (timedOut ? 'AI phản hồi quá lâu. Nội dung được giữ để thử lại.' : 'Đã hủy. Nội dung được giữ để gửi lại.')
        : (err.message || 'Không xử lý được yêu cầu. Hãy thử lại.');

      setMessages(prev => [
        ...prev.slice(-39),
        {
          id: (Date.now() + 1).toString(),
          author: 'Thông báo',
          text: errMsg,
          isUser: false,
        }
      ]);
      setStatus('Chưa tạo được phòng • Có thể gửi lại');
    } finally {
      clearTimeout(timeout);
      setIsBusy(false);
      abortControllerRef.current = null;
    }
  };

  const handleSelectFurniture = (label, description) => {
    setMessages(prev => [
      ...prev.slice(-39),
      {
        id: Date.now().toString(),
        author: 'Đồ vật: ' + label,
        text: description,
        isUser: false,
      }
    ]);
  };

  const handleRestrictedTouch = (label, dialogue) => {
    setStatus(`Vùng hạn chế: ${label}`);
    setMessages(prev => [
      ...prev.slice(-39),
      {
        id: Date.now().toString(),
        author: '👵 Bạn đồng hành',
        text: dialogue || 'Chưa có đủ thông tin về khu vực này; đây là phần AI ước đoán.',
        isUser: false,
      }
    ]);
  };

  const handlePovChange = (mode, label) => {
    setPovMode(mode);
    setFocusedLabel(label || '');
    if (mode === 'focused') {
      setStatus(`Đang đứng tại: ${label || 'đồ vật'} • Vuốt để ngắm nhìn quanh phòng`);
    } else {
      setStatus('Đã trở về góc nhìn tổng quan phòng');
    }
  };

  return (
    <SafeAreaProvider><SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" backgroundColor="#f4efe8" />
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        {/* Header */}
        <View style={styles.header}>
          <View>
            <Text style={styles.appTitle}>MEMORYWEAVER</Text>
            <Text style={styles.appSubtitle}>Phác thảo không gian từ chữ và ảnh</Text>
          </View>
          <TouchableOpacity style={styles.settingsBtn} onPress={openSettings}>
            <Text style={styles.settingsBtnText}>Cài đặt</Text>
          </TouchableOpacity>
        </View>

        {/* === 3D Room Viewer (Tập trung không gian 3D trực quan) === */}
        <View style={[styles.viewerContainer, isExpanded ? styles.viewerContainerExpanded : styles.viewerContainerNormal]}>
          <View style={styles.viewerHeader}>
            <View style={{ flex: 1 }}>
              <Text style={styles.roomTitleText} numberOfLines={1}>{roomTitle}</Text>
              {povMode === 'focused' ? (
                <Text style={styles.povSubtitleText}>👁️ Đang đứng cạnh: {focusedLabel} (Vuốt để nhìn quanh)</Text>
              ) : currentRoom ? (
                <Text style={styles.povSubtitleText}>🧠 Bộ nhớ bật • Gõ để chỉnh sửa tiếp đến khi đúng ý</Text>
              ) : null}
            </View>
            <View style={styles.viewerControls}>
              <TouchableOpacity
                style={styles.expandBtn}
                onPress={() => setIsExpanded(prev => !prev)}
                accessibilityLabel="Phóng to hoặc thu nhỏ căn phòng"
              >
                <Text style={styles.expandBtnText}>{isExpanded ? '🗗 Thu gọn' : '⛶ Mở rộng'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.resetBtn} disabled={!currentRoom} onPress={() => setNavMode(mode => mode === 'fpv' ? 'overview' : 'fpv')}>
                <Text style={styles.resetBtnText}>{navMode === 'fpv' ? 'Toàn cảnh' : 'Bước vào phòng'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.resetBtn} onPress={resetRoom}>
                <Text style={styles.resetBtnText}>Làm mới</Text>
              </TouchableOpacity>
            </View>
          </View>

            <RoomViewer3D
              room={currentRoom}
              textures={textures}
              navMode={navMode}
              onNavModeChange={setNavMode}
              onNavWarning={message => setStatus(message)}
              cameraView={cameraView}
              onSelectFurniture={handleSelectFurniture}
              onRestrictedTouch={handleRestrictedTouch}
              onPovChange={handlePovChange}
            />

        </View>

        {/* Chat & Controls Area */}
        <View style={[styles.chatSection, isExpanded && styles.chatSectionCollapsed]}>
          <View style={styles.statusBar}>
            <Text style={styles.statusText}>{status}</Text>
          </View>

          {/* Thanh hiển thị trạng thái Bộ nhớ phòng (Room Memory Banner) */}
          {currentRoom ? (
            <View style={styles.memoryBar}>
              <View style={styles.memoryLeft}>
                <Text style={styles.memoryIcon}>🧠</Text>
                <Text style={styles.memoryText} numberOfLines={1}>
                  Phòng trong phiên này • Gõ để chỉnh sửa tiếp
                </Text>
              </View>
              <TouchableOpacity
                style={styles.newRoomBtn}
                onPress={() => {
                  Alert.alert(
                    'Tạo phòng mới',
                    'Bạn có muốn làm mới bộ nhớ để thiết kế căn phòng mới từ đầu không?',
                    [
                      { text: 'Hủy', style: 'cancel' },
                      {
                        text: 'Tạo phòng mới',
                        style: 'destructive',
                        onPress: () => {
                          resetRoom();
                          setStatus('Đã làm mới bộ nhớ • Nhập mô tả để tạo phòng mới');
                        }
                      }
                    ]
                  );
                }}
              >
                <Text style={styles.newRoomBtnText}>↺ Phòng mới</Text>
              </TouchableOpacity>
            </View>
          ) : null}

          {/* Messages list */}
          <ScrollView
            ref={scrollViewRef}
            style={styles.messageList}
            contentContainerStyle={styles.messageListContent}
            onContentSizeChange={() => scrollViewRef.current?.scrollToEnd({ animated: true })}
          >
            {messages.map(msg => (
              <View
                key={msg.id}
                style={[
                  styles.messageBubble,
                  msg.isUser ? styles.userBubble : styles.aiBubble
                ]}
              >
                <Text style={[styles.messageAuthor, msg.isUser && { color: '#d9eee3' }]}>{msg.author}</Text>
                <Text style={[styles.messageText, msg.isUser && { color: '#ffffff' }]}>{msg.text}</Text>
              </View>
            ))}
          </ScrollView>

          {/* Quick suggestions when starting fresh */}
          {!currentRoom && !isBusy ? (
            <View style={styles.suggestionsWrapper}>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.suggestionsContainer}
              >
                {CAREGIVER_SUGGESTIONS.map((sug, idx) => (
                  <TouchableOpacity
                    key={'cg-' + idx}
                    style={styles.caregiverChip}
                    onPress={() => setInputText(sug.text)}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.caregiverChipText}>{sug.label}</Text>
                  </TouchableOpacity>
                ))}
                {SUGGESTIONS.map((sug, idx) => (
                  <TouchableOpacity
                    key={'sug-' + idx}
                    style={styles.suggestionChip}
                    onPress={() => setInputText(sug)}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.suggestionText}>💡 {sug}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          ) : null}

          {/* Image preview / status bar */}
          <View style={styles.attachmentBar}>
            {imageUri ? (
              <View style={styles.attachedRow}>
                <Image source={{ uri: imageUri }} style={styles.thumbImage} />
                <Text style={styles.attachedText}>Đã chọn ảnh • Sẵn sàng gửi</Text>
                <TouchableOpacity disabled={isBusy} onPress={clearImage} style={styles.clearImgBtn}>
                  <Text style={styles.clearImgText}>Bỏ ảnh</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <Text style={styles.unattachedText}>Chưa chọn ảnh</Text>
            )}
          </View>

          {/* Input Row */}
          <View style={styles.inputRow}>
            <TouchableOpacity
              style={[styles.photoBtn, isBusy && styles.disabledBtn]}
              onPress={pickImage}
              disabled={isBusy || isPicking}
            >
              <Text style={styles.photoBtnText}>{isPicking ? 'Đợi…' : '+ Ảnh'}</Text>
            </TouchableOpacity>

            <TouchableOpacity disabled={isBusy} onPress={() => setUsePhotoTexture(value => !value)}>
              <Text style={styles.photoBtnText}>{usePhotoTexture ? 'Texture: bật' : 'Texture: tắt'}</Text>
            </TouchableOpacity>
            <TextInput
              style={styles.textInput}
              placeholder="Ví dụ: Phòng khách ấm áp, sofa xanh và bàn gỗ…"
              placeholderTextColor="#8d9b94"
              value={inputText}
              onChangeText={setInputText}
              multiline
              maxLength={4000}
              editable={!isBusy}
            />

            <TouchableOpacity
              style={[styles.sendBtn, isBusy && styles.cancelBtn]}
              accessibilityLabel={isBusy ? 'Hủy yêu cầu' : 'Gửi mô tả phòng'}
              onPress={handleSendOrCancel}
              disabled={isPicking}
            >
              {isBusy ? (
                <Text style={styles.sendBtnText}>Hủy</Text>
              ) : (
                <Text style={styles.sendBtnText}>Gửi</Text>
              )}
            </TouchableOpacity>
          </View>

          <Text style={styles.hintFooter}>
            Góc nhìn cố định đẹp nhất · Chụm 2 ngón để phóng to · Chạm đồ vật để xem chi tiết
          </Text>
        </View>
      </KeyboardAvoidingView>

      {/* Settings Modal */}
      <Modal onRequestClose={() => setSettingsVisible(false)} visible={settingsVisible} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Kết nối Server AI</Text>

            <Text style={styles.inputLabel}>Địa chỉ Server:</Text>
            <TextInput
              style={styles.modalInput}
              value={inputEndpoint}
              onChangeText={setInputEndpoint}
              placeholder="http://192.168.1.17:8787"
              autoCapitalize="none"
              autoCorrect={false}
            />

            <Text style={styles.inputLabel}>Mã truy cập APP_ACCESS_TOKEN:</Text>
            <TextInput
              style={styles.modalInput}
              value={inputToken}
              onChangeText={setInputToken}
              placeholder="Mã 48 ký tự trong file Server/.env"
              secureTextEntry
              autoCapitalize="none"
            />

            <Text style={styles.modalHelp}>
              • Điện thoại và máy tính cần kết nối chung Wi-Fi.{'\n'}
              • Nhập IP Wi-Fi của máy tính kèm cổng 8787.{'\n'}
              • Mã token lấy từ file Server/.env trên máy tính. Không nhập khóa Gemini vào app.
            </Text>

            <TouchableOpacity
              style={styles.diagModalBtn}
              onPress={() => {
                setSettingsVisible(false);
                loadDiagnosis();
              }}
            >
              <Text style={styles.diagModalBtnText}>Kiểm tra khả năng xử lý ảnh</Text>
            </TouchableOpacity>

            <View style={styles.modalBtnRow}>
              <TouchableOpacity style={[styles.modalBtn, styles.saveBtn]} onPress={saveSettings}>
                <Text style={styles.saveBtnText}>Lưu kết nối</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.modalBtn, styles.closeBtn]} onPress={() => setSettingsVisible(false)}>
                <Text style={styles.closeBtnText}>Đóng</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView></SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#f4efe8',
  },
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#f4efe8',
    borderBottomWidth: 1,
    borderBottomColor: '#e5ded4',
  },
  appTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#213835',
    letterSpacing: 0.5,
  },
  appSubtitle: {
    fontSize: 11,
    color: '#496b61',
  },
  settingsBtn: {
    backgroundColor: '#2e6151',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 6,
  },
  settingsBtnText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '600',
  },
  viewerContainer: {
    backgroundColor: '#1c2421',
  },
  viewerContainerNormal: {
    flex: 1.55,
  },
  viewerContainerExpanded: {
    flex: 3.5,
  },
  viewerHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 6,
    backgroundColor: '#161e1b',
    borderBottomWidth: 1,
    borderBottomColor: '#25302c',
  },
  roomTitleText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#95d1bd',
    letterSpacing: 0.5,
    flexShrink: 1,
    marginRight: 6,
  },
  viewerControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  camPresetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#24322d',
    borderRadius: 5,
    padding: 2,
    gap: 2,
  },
  camBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#a1c2b5',
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  resetBtn: {
    backgroundColor: '#2e4e42',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 4,
  },
  resetBtnText: {
    color: '#e4ece8',
    fontSize: 11,
    fontWeight: '600',
  },
  suggestionsWrapper: {
    backgroundColor: '#ebf1ec',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#d6dfd9',
  },
  suggestionsContainer: {
    paddingHorizontal: 10,
    gap: 6,
    flexDirection: 'row',
  },
  suggestionChip: {
    backgroundColor: '#ffffff',
    borderColor: '#c6d4cc',
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  suggestionText: {
    fontSize: 11,
    color: '#214036',
    fontWeight: '500',
  },
  chatSection: {
    flex: 0.9,
    backgroundColor: '#f3f6f3',
    borderTopWidth: 1,
    borderTopColor: '#d6ded8',
  },
  chatSectionCollapsed: {
    flex: 0.55,
  },
  statusBar: {
    paddingHorizontal: 14,
    paddingVertical: 4,
    backgroundColor: '#e5ece7',
  },
  statusText: {
    fontSize: 11,
    color: '#34554b',
  },
  memoryBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#e3ece6',
    borderBottomWidth: 1,
    borderBottomColor: '#d0ddd4',
    paddingHorizontal: 12,
    paddingVertical: 5,
    gap: 8,
  },
  memoryLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: 6,
  },
  memoryIcon: {
    fontSize: 13,
  },
  memoryText: {
    fontSize: 11,
    color: '#264a3e',
    fontWeight: '600',
    flex: 1,
  },
  newRoomBtn: {
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#b4c9be',
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  newRoomBtnText: {
    fontSize: 10.5,
    color: '#2c594b',
    fontWeight: '700',
  },
  diagModalBtn: {
    backgroundColor: '#ebf4ef',
    borderWidth: 1,
    borderColor: '#a8c6b6',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    marginBottom: 12,
  },
  diagModalBtnText: {
    color: '#215343',
    fontSize: 12.5,
    fontWeight: '600',
  },
  messageList: {
    flex: 1,
    paddingHorizontal: 12,
  },
  messageListContent: {
    paddingVertical: 8,
  },
  messageBubble: {
    borderRadius: 8,
    padding: 10,
    marginVertical: 4,
    maxWidth: '90%',
  },
  userBubble: {
    alignSelf: 'flex-end',
    backgroundColor: '#2e6151',
  },
  aiBubble: {
    alignSelf: 'flex-start',
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#d4ded8',
  },
  messageAuthor: {
    fontSize: 10,
    fontWeight: '700',
    marginBottom: 2,
    color: '#87948e',
  },
  messageText: {
    fontSize: 13,
    lineHeight: 18,
    color: '#1a2624',
  },
  attachmentBar: {
    paddingHorizontal: 14,
    paddingVertical: 4,
    backgroundColor: '#e9efe9',
    flexDirection: 'row',
    alignItems: 'center',
  },
  unattachedText: {
    fontSize: 11,
    color: '#71857c',
  },
  attachedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  thumbImage: {
    width: 22,
    height: 22,
    borderRadius: 3,
    marginRight: 8,
  },
  attachedText: {
    fontSize: 11,
    color: '#2e6151',
    fontWeight: '600',
    flex: 1,
  },
  clearImgBtn: {
    backgroundColor: '#d85140',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
  },
  clearImgText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '600',
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: '#fbfcfb',
  },
  photoBtn: {
    backgroundColor: '#2e6151',
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderRadius: 6,
    marginRight: 6,
  },
  photoBtnText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
  textInput: {
    flex: 1,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#cad4ce',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 13,
    maxHeight: 70,
    color: '#213835',
  },
  sendBtn: {
    backgroundColor: '#2e6151',
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 6,
    marginLeft: 6,
  },
  cancelBtn: {
    backgroundColor: '#c44536',
  },
  sendBtnText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
  disabledBtn: {
    opacity: 0.5,
  },
  hintFooter: {
    fontSize: 9.5,
    textAlign: 'center',
    color: '#657770',
    paddingBottom: 4,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    padding: 20,
  },
  modalContent: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 20,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#213835',
    marginBottom: 16,
  },
  inputLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#496b61',
    marginBottom: 4,
    marginTop: 8,
  },
  modalInput: {
    borderWidth: 1,
    borderColor: '#c6d1cb',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    color: '#213835',
  },
  modalHelp: {
    fontSize: 11,
    lineHeight: 16,
    color: '#6e8078',
    marginVertical: 14,
  },
  modalBtnRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
  },
  modalBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 6,
  },
  saveBtn: {
    backgroundColor: '#2e6151',
  },
  saveBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 13,
  },
  closeBtn: {
    backgroundColor: '#e6ece8',
  },
  closeBtnText: {
    color: '#344741',
    fontWeight: '600',
    fontSize: 13,
  },
  povSubtitleText: {
    fontSize: 10.5,
    color: '#a3c2b5',
    fontWeight: '600',
    marginTop: 2,
  },
  tabToggleRow: {
    flexDirection: 'row',
    backgroundColor: '#1b2521',
    borderRadius: 6,
    padding: 2,
    marginRight: 6,
  },
  tabBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  tabBtnActive: {
    backgroundColor: '#2e6151',
  },
  tabBtnText: {
    fontSize: 11,
    color: '#8ea59b',
    fontWeight: '600',
  },
  tabBtnTextActive: {
    color: '#ffffff',
    fontWeight: '700',
  },
  refinedImageContainer: {
    flex: 1,
    backgroundColor: '#1c2421',
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
  },
  refinedImage: {
    width: '100%',
    height: '100%',
  },
  refinedCaptionBadge: {
    position: 'absolute',
    bottom: 12,
    backgroundColor: 'rgba(20, 28, 25, 0.88)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#32453c',
  },
  refinedCaptionText: {
    color: '#81c784',
    fontSize: 10.5,
    fontWeight: '600',
  },
  routineBar: {
    backgroundColor: '#e3ece6',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#d0ddd4',
    flexDirection: 'row',
    alignItems: 'center',
  },
  routineTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: '#213835',
    marginRight: 6,
  },
  routineChip: {
    backgroundColor: '#ffffff',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
    marginRight: 6,
    borderWidth: 1,
    borderColor: '#cad7cf',
  },
  routineChipText: {
    fontSize: 10.5,
    color: '#2b5446',
    fontWeight: '600',
  },
  caregiverChip: {
    backgroundColor: '#2e6151',
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 14,
    marginRight: 6,
  },
  caregiverChipText: {
    fontSize: 11.5,
    fontWeight: '700',
    color: '#ffffff',
  },
  expandBtn: {
    backgroundColor: '#273e35',
    borderColor: '#436154',
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 5,
    marginRight: 4,
  },
  expandBtnText: {
    color: '#a8d5c4',
    fontWeight: '700',
    fontSize: 10.5,
  },

  // ===== Multi-Tab Navigation Bar =====
  mainTabBar: {
    flexDirection: 'row',
    backgroundColor: '#1a2723',
    borderBottomWidth: 1,
    borderBottomColor: '#2d3f38',
    paddingHorizontal: 4,
  },
  mainTabItem: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  mainTabItemActive: {
    borderBottomColor: '#4fd1a0',
    backgroundColor: '#1f332c',
  },
  mainTabText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#6b8c7f',
  },
  mainTabTextActive: {
    color: '#4fd1a0',
    fontWeight: '800',
  },

  // ===== Tab Scroll Content =====
  tabScrollContent: {
    flex: 1,
    backgroundColor: '#131b18',
  },
  tabScrollInner: {
    padding: 12,
    paddingBottom: 24,
  },

  // ===== Loading State =====
  tabLoadingBox: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 60,
  },
  tabLoadingEmoji: {
    fontSize: 40,
    marginBottom: 12,
  },
  tabLoadingText: {
    color: '#95d1bd',
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'center',
  },
  tabLoadingSubtext: {
    color: '#5c8a79',
    fontSize: 11,
    marginTop: 6,
    textAlign: 'center',
  },

  // ===== Empty State =====
  tabEmptyBox: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 50,
  },
  tabEmptyEmoji: {
    fontSize: 44,
    marginBottom: 10,
  },
  tabEmptyText: {
    color: '#6b8c7f',
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 16,
  },
  tabActionBtn: {
    backgroundColor: '#2e6151',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
    marginTop: 8,
  },
  tabActionBtnText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700',
  },

  // ===== Sprite Cards (Tách lớp) =====
  spriteCard: {
    backgroundColor: '#1f2d28',
    borderRadius: 10,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#2d4039',
    overflow: 'hidden',
  },
  spriteHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#192521',
    borderBottomWidth: 1,
    borderBottomColor: '#263832',
  },
  spriteBadge: {
    fontSize: 10.5,
    fontWeight: '700',
    color: '#8bc1ab',
  },
  spriteName: {
    fontSize: 13,
    fontWeight: '700',
    color: '#c8e6d8',
  },
  spriteImageWrap: {
    backgroundColor: '#111917',
    padding: 8,
    alignItems: 'center',
    minHeight: 100,
  },
  spriteImage: {
    width: '100%',
    height: 120,
  },
  spriteNoImage: {
    padding: 16,
    alignItems: 'center',
    backgroundColor: '#151e1a',
  },
  spriteNoImageText: {
    color: '#4a6b5f',
    fontSize: 11,
    fontStyle: 'italic',
  },
  spriteMeta: {
    color: '#5c8a79',
    fontSize: 10,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  spriteDialogue: {
    backgroundColor: '#162320',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: '#233530',
  },
  spriteDialogueText: {
    color: '#a8c5b6',
    fontSize: 11,
    fontStyle: 'italic',
    lineHeight: 16,
  },

  // ===== Depth & Inpainting =====
  depthSection: {
    marginBottom: 16,
  },
  depthSectionTitle: {
    color: '#95d1bd',
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 8,
  },
  depthMapImage: {
    width: '100%',
    height: 220,
    borderRadius: 8,
    backgroundColor: '#0d1511',
  },

  // ===== Diagnosis =====
  diagTitle: {
    color: '#c8e6d8',
    fontSize: 16,
    fontWeight: '800',
    marginBottom: 12,
  },
  diagCard: {
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
  },
  diagCardOk: {
    backgroundColor: '#19302a',
    borderColor: '#2d5a48',
  },
  diagCardWarn: {
    backgroundColor: '#302219',
    borderColor: '#5a3e2d',
  },
  diagModName: {
    color: '#c8e6d8',
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 4,
  },
  diagModDetail: {
    color: '#7faa97',
    fontSize: 11.5,
    lineHeight: 17,
  },
  diagModMeta: {
    color: '#4d7366',
    fontSize: 10,
    marginTop: 4,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
});

