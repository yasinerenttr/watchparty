import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import io from 'socket.io-client'
import './App.css'

const SOCKET_URL = window.location.hostname === 'localhost' ? 'http://localhost:3001' : `http://${window.location.hostname}:3001`

function App() {
  const [joined, setJoined] = useState(false)
  const [roomId, setRoomId] = useState('')
  const [username, setUsername] = useState('')
  const [roomIdInput, setRoomIdInput] = useState('')
  const [usernameInput, setUsernameInput] = useState('')
  const [loginMode, setLoginMode] = useState(null) // null | 'create' | 'join'
  const [generatedCode, setGeneratedCode] = useState('')
  const [codeCopied, setCodeCopied] = useState(false)

  const [users, setUsers] = useState([])
  const [messages, setMessages] = useState([])
  const [reactions, setReactions] = useState([])
  const [chatInput, setChatInput] = useState('')

  const [cameraEnabled, setCameraEnabled] = useState(false)
  const [micEnabled, setMicEnabled] = useState(false)
  const [screenSharing, setScreenSharing] = useState(false)
  const [remoteScreenActive, setRemoteScreenActive] = useState(false)
  const [mediaWarning, setMediaWarning] = useState('')
  const [mainView, setMainView] = useState('partner')
  const [remoteHasVideo, setRemoteHasVideo] = useState(false)

  const localVideoRef = useRef(null)
  const remoteVideoRef = useRef(null)
  const screenShareRef = useRef(null)
  const remoteMiniVideoRef = useRef(null)
  const screenMiniRef = useRef(null)

  const socketRef = useRef(null)
  const peerConnectionsRef = useRef({})
  const localStreamRef = useRef(null)
  const remoteStreamRef = useRef(new MediaStream())
  const remoteScreenStreamRef = useRef(new MediaStream())
  const screenStreamRef = useRef(null)
  const videoSendersRef = useRef({})
  const pendingIceRef = useRef({})

  const STUN_SERVERS = useMemo(
    () => [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' }
    ],
    []
  )

  const syncLocalVideo = useCallback(() => {
    if (localVideoRef.current && localStreamRef.current) {
      localVideoRef.current.srcObject = localStreamRef.current
    }
  }, [])

  const syncRemoteVideo = useCallback(() => {
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = remoteStreamRef.current
    }
    if (remoteMiniVideoRef.current) {
      remoteMiniVideoRef.current.srcObject = remoteStreamRef.current
    }
  }, [])

  const syncScreenVideo = useCallback((stream) => {
    if (screenShareRef.current) {
      screenShareRef.current.srcObject = stream || null
    }
    if (screenMiniRef.current) {
      screenMiniRef.current.srcObject = stream || null
    }
  }, [])

  const getOtherUsers = useCallback(
    (roomUsers) => roomUsers.filter((u) => u.id !== socketRef.current?.id),
    []
  )

  const ensureLocalMedia = useCallback(async () => {
    if (localStreamRef.current) return localStreamRef.current

    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: true
    })

    localStreamRef.current = stream

    stream.getVideoTracks().forEach((track) => {
      track.enabled = cameraEnabled
    })
    stream.getAudioTracks().forEach((track) => {
      track.enabled = micEnabled
    })

    syncLocalVideo()
    setMediaWarning('')
    return stream
  }, [cameraEnabled, micEnabled, syncLocalVideo])

  const updateSenders = useCallback(async (peerId) => {
    const senders = videoSendersRef.current[peerId]
    if (!senders) return

    const promises = []

    const audioTrack = localStreamRef.current?.getAudioTracks()[0] || null
    if (senders.audio.track !== audioTrack) promises.push(senders.audio.replaceTrack(audioTrack))

    const videoTrack = localStreamRef.current?.getVideoTracks()[0] || null
    if (senders.video.track !== videoTrack) promises.push(senders.video.replaceTrack(videoTrack))

    const screenTrack = screenStreamRef.current?.getVideoTracks()[0] || null
    if (senders.screen.track !== screenTrack) promises.push(senders.screen.replaceTrack(screenTrack))

    const screenAudioTrack = screenStreamRef.current?.getAudioTracks()[0] || null
    if (senders.screenAudio.track !== screenAudioTrack) promises.push(senders.screenAudio.replaceTrack(screenAudioTrack))

    await Promise.all(promises)
  }, [])

  const flushPendingIce = useCallback(async (peerId) => {
    const pc = peerConnectionsRef.current[peerId]
    const queue = pendingIceRef.current[peerId]
    if (!pc || !queue || queue.length === 0) return

    for (const candidate of queue) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate))
      } catch (err) {
        console.error('Pending ICE add error:', err)
      }
    }
    pendingIceRef.current[peerId] = []
  }, [])

  const renegotiateForAllPeers = useCallback(async () => {
    for (const peerId of Object.keys(peerConnectionsRef.current)) {
      const pc = peerConnectionsRef.current[peerId]
      if (!pc) continue
      try {
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        socketRef.current?.emit('offer', { roomId, to: peerId, offer })
      } catch (err) {
        console.error('Renegotiation failed:', err)
      }
    }
  }, [roomId])

  const createPeerConnection = useCallback(
    async (peerId, initiator = false) => {
      if (peerConnectionsRef.current[peerId]) return peerConnectionsRef.current[peerId]

      const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS })
      peerConnectionsRef.current[peerId] = pc

      if (initiator) {
        pc.addTransceiver('audio', { direction: 'sendrecv' })
        pc.addTransceiver('video', { direction: 'sendrecv' })
        pc.addTransceiver('video', { direction: 'sendrecv' })
        pc.addTransceiver('audio', { direction: 'sendrecv' })
      }

      pc.ontrack = (event) => {
        const transceivers = pc.getTransceivers()
        const isScreenVideo = event.transceiver === transceivers[2]
        const isScreenAudio = event.transceiver === transceivers[3]

        if (isScreenVideo || isScreenAudio) {
          if (!remoteScreenStreamRef.current.getTracks().some((t) => t.id === event.track.id)) {
            remoteScreenStreamRef.current.addTrack(event.track)
            syncScreenVideo(remoteScreenStreamRef.current)
          }
        } else {
          if (!remoteStreamRef.current.getTracks().some((t) => t.id === event.track.id)) {
            remoteStreamRef.current.addTrack(event.track)
          }
          if (event.track.kind === 'video') {
            setRemoteHasVideo(true)
          }
          syncRemoteVideo()
        }
      }

      pc.onicecandidate = (event) => {
        if (!event.candidate || !socketRef.current) return
        socketRef.current.emit('ice-candidate', {
          roomId,
          to: peerId,
          candidate: event.candidate
        })
      }

      pc.onconnectionstatechange = () => {
        const state = pc.connectionState
        if (state === 'failed' || state === 'closed' || state === 'disconnected') {
          if (peerConnectionsRef.current[peerId]) {
            peerConnectionsRef.current[peerId].close()
            delete peerConnectionsRef.current[peerId]
            delete videoSendersRef.current[peerId]
          }
        }
      }

      if (initiator) {
        const transceivers = pc.getTransceivers()
        videoSendersRef.current[peerId] = {
          audio: transceivers[0].sender,
          video: transceivers[1].sender,
          screen: transceivers[2].sender,
          screenAudio: transceivers[3].sender
        }
        await updateSenders(peerId)

        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        socketRef.current?.emit('offer', { roomId, to: peerId, offer })
      }

      return pc
    },
    [STUN_SERVERS, roomId, syncRemoteVideo, updateSenders]
  )

  const handleIncomingOffer = useCallback(
    async ({ from, offer }) => {
      const pc = await createPeerConnection(from, false)
      await pc.setRemoteDescription(new RTCSessionDescription(offer))
      
      const transceivers = pc.getTransceivers()
      videoSendersRef.current[from] = {
        audio: transceivers[0].sender,
        video: transceivers[1].sender,
        screen: transceivers[2].sender,
        screenAudio: transceivers[3].sender
      }
      await updateSenders(from)

      await flushPendingIce(from)

      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      socketRef.current?.emit('answer', { roomId, to: from, answer })
    },
    [createPeerConnection, flushPendingIce, roomId, updateSenders]
  )

  const handleIncomingAnswer = useCallback(async ({ from, answer }) => {
    const pc = peerConnectionsRef.current[from]
    if (!pc) return

    await pc.setRemoteDescription(new RTCSessionDescription(answer))
    await flushPendingIce(from)
  }, [flushPendingIce])

  const handleIncomingIce = useCallback(async ({ from, candidate }) => {
    const pc = peerConnectionsRef.current[from]
    if (!pc || !pc.remoteDescription) {
      if (!pendingIceRef.current[from]) pendingIceRef.current[from] = []
      pendingIceRef.current[from].push(candidate)
      return
    }

    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate))
    } catch (err) {
      console.error('ICE add error:', err)
    }
  }, [])

  const broadcastMediaState = useCallback(() => {
    socketRef.current?.emit('update-media', {
      roomId,
      username,
      camera: cameraEnabled,
      microphone: micEnabled
    })
  }, [cameraEnabled, micEnabled, roomId, username])

  const handleJoinRoom = async (e) => {
    e.preventDefault()
    const nextRoom = roomIdInput.trim()
    const nextUsername = usernameInput.trim()
    if (!nextRoom || !nextUsername) return

    try {
      setRoomId(nextRoom)
      setUsername(nextUsername)

      try {
        await ensureLocalMedia()
      } catch (mediaErr) {
        console.warn('Media permission denied or unavailable at join:', mediaErr)
        setMediaWarning('Kamera/mikrofon izni yok. Odaya girdin, sonra butonlardan tekrar açabilirsin.')
      }

      const socket = io(SOCKET_URL, {
        transports: ['websocket'],
        reconnection: true
      })
      socketRef.current = socket

      socket.on('connect', () => {
        socket.emit('join-room', { roomId: nextRoom, username: nextUsername })
      })

      socket.on('room-users', async (roomUsers) => {
        setUsers(roomUsers)
        const others = getOtherUsers(roomUsers)
        for (const user of others) {
          await createPeerConnection(user.id, false)
        }
      })

      socket.on('user-joined', async ({ userId, username: joinedName }) => {
        setUsers((prev) => {
          const exists = prev.some((u) => u.id === userId)
          if (exists) return prev
          return [...prev, { id: userId, username: joinedName, camera: false, microphone: false }]
        })
        await createPeerConnection(userId, true)
      })

      socket.on('user-left', ({ userId }) => {
        setUsers((prev) => prev.filter((u) => u.id !== userId))
        const pc = peerConnectionsRef.current[userId]
        if (pc) {
          pc.close()
          delete peerConnectionsRef.current[userId]
          delete videoSendersRef.current[userId]
          delete pendingIceRef.current[userId]
        }
        remoteStreamRef.current = new MediaStream()
        remoteScreenStreamRef.current = new MediaStream()
        syncRemoteVideo()
        setRemoteScreenActive(false)
        setRemoteHasVideo(false)
      })

      socket.on('media-updated', ({ userId, camera, microphone }) => {
        setUsers((prev) =>
          prev.map((u) => (u.id === userId ? { ...u, camera, microphone } : u))
        )
      })

      socket.on('offer', handleIncomingOffer)
      socket.on('answer', handleIncomingAnswer)
      socket.on('ice-candidate', handleIncomingIce)

      socket.on('screen-share-started', () => {
        setRemoteScreenActive(true)
        setMainView('screen')
      })

      socket.on('screen-share-stopped', () => {
        setRemoteScreenActive(false)
        syncScreenVideo(null)
        setMainView('partner')
      })

      socket.on('chat-message', ({ id, username: senderName, message, createdAt }) => {
        setMessages((prev) => [
          ...prev,
          {
            id: id || `${Date.now()}-${Math.random()}`,
            username: senderName || 'Misafir',
            message,
            createdAt: createdAt || new Date().toISOString()
          }
        ])
      })

      socket.on('reaction', ({ type, id }) => {
        const left = Math.random() * 80 + 10
        setReactions((prev) => [...prev, { id, type, left }])
        setTimeout(() => {
          setReactions((prev) => prev.filter((r) => r.id !== id))
        }, 3000)
      })

      setJoined(true)
      setTimeout(() => {
        broadcastMediaState()
      }, 0)
    } catch (err) {
      console.error(err)
      alert('Bağlantı başlatılamadı. Backend çalışıyor mu kontrol et (localhost:3001).')
    }
  }

  const toggleCamera = async () => {
    try {
      let stream = localStreamRef.current
      if (!stream) {
        stream = new MediaStream()
        localStreamRef.current = stream
      }

      let videoTrack = stream.getVideoTracks()[0]
      if (!videoTrack) {
        const camStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
        videoTrack = camStream.getVideoTracks()[0]
        stream.addTrack(videoTrack)
        syncLocalVideo()
      }
      const enabled = !cameraEnabled

      if (videoTrack) videoTrack.enabled = enabled

      setCameraEnabled(enabled)
      setMediaWarning('')
      
      await Promise.all(Object.keys(peerConnectionsRef.current).map((peerId) => updateSenders(peerId)))

      setTimeout(broadcastMediaState, 0)
    } catch (err) {
      console.error('Camera error:', err)
      setMediaWarning('Kamera açılamadı. Tarayıcı izinlerini kontrol et.')
    }
  }

  const toggleMicrophone = async () => {
    try {
      let stream = localStreamRef.current
      if (!stream) {
        stream = new MediaStream()
        localStreamRef.current = stream
      }

      let audioTrack = stream.getAudioTracks()[0]
      if (!audioTrack) {
        const micStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true })
        audioTrack = micStream.getAudioTracks()[0]
        stream.addTrack(audioTrack)
      }
      const enabled = !micEnabled

      if (audioTrack) audioTrack.enabled = enabled

      setMicEnabled(enabled)
      setMediaWarning('')

      await Promise.all(Object.keys(peerConnectionsRef.current).map((peerId) => updateSenders(peerId)))

      setTimeout(broadcastMediaState, 0)
    } catch (err) {
      console.error('Mic error:', err)
      setMediaWarning('Mikrofon açılamadı. Tarayıcı izinlerini kontrol et.')
    }
  }

  const stopScreenShare = useCallback(async () => {
    const currentScreen = screenStreamRef.current
    if (!currentScreen) return

    currentScreen.getTracks().forEach((t) => t.stop())
    screenStreamRef.current = null
    setScreenSharing(false)
    setMainView('partner')

    await Promise.all(Object.keys(peerConnectionsRef.current).map((peerId) => updateSenders(peerId)))
    await renegotiateForAllPeers()

    socketRef.current?.emit('screen-share-stop', { roomId })
  }, [roomId, updateSenders, renegotiateForAllPeers])

  const toggleScreenShare = async () => {
    try {
      if (screenSharing) {
        await stopScreenShare()
        return
      }

      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true
      })

      screenStreamRef.current = displayStream
      setScreenSharing(true)
      setMainView('screen')

      const screenTrack = displayStream.getVideoTracks()[0]
      screenTrack.onended = async () => {
        await stopScreenShare()
      }

      await Promise.all(Object.keys(peerConnectionsRef.current).map((peerId) => updateSenders(peerId)))
      await renegotiateForAllPeers()

      socketRef.current?.emit('screen-share-start', { roomId })
    } catch (err) {
      console.error('Screen share error:', err)
      setMediaWarning('Ekran paylaşımı başlatılamadı.')
    }
  }

  const handleSendMessage = (e) => {
    e.preventDefault()
    const text = chatInput.trim()
    if (!text || !socketRef.current || !roomId) return

    socketRef.current.emit('chat-message', {
      roomId,
      username,
      message: text
    })
    setChatInput('')
  }

  const handleSendReaction = (type) => {
    if (!socketRef.current || !roomId) return
    const id = `${Date.now()}-${Math.random()}`
    const left = Math.random() * 80 + 10
    setReactions((prev) => [...prev, { id, type, left }])
    setTimeout(() => {
      setReactions((prev) => prev.filter((r) => r.id !== id))
    }, 3000)
    socketRef.current.emit('reaction', { roomId, type })
  }

  const handleLeaveRoom = useCallback(async () => {
    if (screenStreamRef.current) {
      await stopScreenShare()
    }

    Object.values(peerConnectionsRef.current).forEach((pc) => pc.close())
    peerConnectionsRef.current = {}
    videoSendersRef.current = {}
    pendingIceRef.current = {}

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop())
      localStreamRef.current = null
    }

    if (localVideoRef.current) localVideoRef.current.srcObject = null
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null
    if (screenShareRef.current) screenShareRef.current.srcObject = null
    remoteStreamRef.current = new MediaStream()

    socketRef.current?.disconnect()
    socketRef.current = null

    setJoined(false)
    setRoomId('')
    setUsers([])
    setMessages([])
    setChatInput('')
    setCameraEnabled(false)
    setMicEnabled(false)
    setScreenSharing(false)
    setRemoteScreenActive(false)
    setMainView('partner')
    setRemoteHasVideo(false)
  }, [stopScreenShare])

  useEffect(() => {
    syncLocalVideo()
    syncRemoteVideo()
  }, [syncLocalVideo, syncRemoteVideo, mainView, screenSharing, remoteScreenActive, remoteHasVideo])

  useEffect(() => {
    if (screenSharing) {
      syncScreenVideo(screenStreamRef.current)
    } else if (remoteScreenActive) {
      syncScreenVideo(remoteScreenStreamRef.current)
    } else {
      syncScreenVideo(null)
    }
  }, [remoteScreenActive, screenSharing, syncScreenVideo, mainView])

  useEffect(() => {
    return () => {
      socketRef.current?.disconnect()
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((t) => t.stop())
      }
      if (screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach((t) => t.stop())
      }
    }
  }, [])

  const hasScreenSource = screenSharing || remoteScreenActive
  const hasPartnerSource = remoteHasVideo
  const showScreenAsMain = mainView === 'screen' && hasScreenSource
  const showPartnerAsMain = !showScreenAsMain && hasPartnerSource

  const generateRoomCode = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    let code = ''
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)]
    return code
  }

  const handleCreateRoom = () => {
    if (!usernameInput.trim()) return
    const code = generateRoomCode()
    setGeneratedCode(code)
    setRoomIdInput(code)
    setLoginMode('create')
  }

  const handleCopyCode = async () => {
    await navigator.clipboard.writeText(generatedCode)
    setCodeCopied(true)
    setTimeout(() => setCodeCopied(false), 2000)
  }

  if (!joined) {
    // Step 0: Choose mode
    if (loginMode === null) {
      return (
        <div className="login-container">
          <div className="login-box">
            <h1 className="login-title">🎬 Watch Party</h1>
            <p className="login-subtitle">Sevgilinle Birlikte Film İzle</p>
            <div className="form-group">
              <label>Kullanıcı Adın</label>
              <input
                type="text"
                placeholder="Adını gir..."
                value={usernameInput}
                onChange={(e) => setUsernameInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()}
                autoFocus
              />
            </div>
            <div className="mode-buttons">
              <button
                type="button"
                className="btn btn-primary mode-btn"
                onClick={handleCreateRoom}
                disabled={!usernameInput.trim()}
              >
                🏠 Oda Oluştur
              </button>
              <button
                type="button"
                className="btn btn-outline mode-btn"
                onClick={() => setLoginMode('join')}
                disabled={!usernameInput.trim()}
              >
                🔗 Odaya Katıl
              </button>
            </div>
            {!usernameInput.trim() && <p className="login-tip">Devam etmek için adını gir 👆</p>}
            {mediaWarning && <p className="login-tip" style={{ color: '#f87171' }}>{mediaWarning}</p>}
          </div>
        </div>
      )
    }

    // Step 1a: Created room – show code
    if (loginMode === 'create') {
      return (
        <div className="login-container">
          <div className="login-box">
            <h1 className="login-title">🎬 Watch Party</h1>
            <p className="login-subtitle">Oda hazır! Kodu partnerinle paylaş</p>

            <div className="room-code-display">
              <span className="room-code-value">{generatedCode}</span>
              <button type="button" className="copy-btn" onClick={handleCopyCode}>
                {codeCopied ? '✅ Kopyalandı!' : '📋 Kopyala'}
              </button>
            </div>

            <p className="login-tip" style={{ textAlign: 'center', marginBottom: 16 }}>
              Partner bu kodu girerek sana katılacak
            </p>

            <form onSubmit={handleJoinRoom}>
              <input type="hidden" value={generatedCode} />
              <button type="submit" className="btn btn-primary" style={{ width: '100%' }}>
                🚀 Odaya Gir
              </button>
            </form>
            <button type="button" className="btn btn-ghost" style={{ width: '100%', marginTop: 8 }}
              onClick={() => { setLoginMode(null); setGeneratedCode(''); setRoomIdInput('') }}
            >
              ← Geri
            </button>
            {mediaWarning && <p className="login-tip" style={{ color: '#f87171' }}>{mediaWarning}</p>}
          </div>
        </div>
      )
    }

    // Step 1b: Join room – enter code
    if (loginMode === 'join') {
      return (
        <div className="login-container">
          <div className="login-box">
            <h1 className="login-title">🎬 Watch Party</h1>
            <p className="login-subtitle">Partnerin verdiği kodu gir</p>
            <form onSubmit={handleJoinRoom}>
              <div className="form-group">
                <label>Oda Kodu</label>
                <input
                  type="text"
                  placeholder="6 haneli kodu gir (örn. ABC123)"
                  value={roomIdInput}
                  onChange={(e) => setRoomIdInput(e.target.value.toUpperCase())}
                  maxLength={6}
                  required
                  autoFocus
                  style={{ textAlign: 'center', fontSize: '1.5em', letterSpacing: 6 }}
                />
              </div>
              <button type="submit" className="btn btn-primary" style={{ width: '100%' }}>
                🚀 Odaya Katıl
              </button>
            </form>
            <button type="button" className="btn btn-ghost" style={{ width: '100%', marginTop: 8 }}
              onClick={() => { setLoginMode(null); setRoomIdInput('') }}
            >
              ← Geri
            </button>
            {mediaWarning && <p className="login-tip" style={{ color: '#f87171' }}>{mediaWarning}</p>}
          </div>
        </div>
      )
    }
  }

  return (
    <div className="watch-party-container">
      <div className="watch-party-header">
        <div className="header-left">
          <h1>🎬 Watch Party</h1>
          <p className="room-info">
            Oda: <span className="room-id-badge">{roomId}</span>
          </p>
        </div>
        <button onClick={handleLeaveRoom} className="btn btn-danger btn-small">
          Ayrıl
        </button>
      </div>

      <div className="watch-party-main">
        <div className="reactions-container">
          {reactions.map((r) => (
            <div
              key={r.id}
              className={`reaction-item reaction-${r.type}`}
              style={{ left: `${r.left}%` }}
            >
              {r.type === 'heart' ? '❤️' : 'Elif'}
            </div>
          ))}
        </div>
        <div className="screen-container">
          {mediaWarning && (
            <div
              style={{
                position: 'absolute',
                top: 12,
                left: '50%',
                transform: 'translateX(-50%)',
                zIndex: 90,
                background: 'rgba(127, 29, 29, 0.9)',
                border: '1px solid rgba(248, 113, 113, 0.7)',
                borderRadius: 8,
                padding: '8px 12px',
                color: '#fecaca',
                fontSize: 13
              }}
            >
              {mediaWarning}
            </div>
          )}
          {showScreenAsMain ? (
            <div key="main-screen" className="video-wrapper screen-share">
              <video
                key="video-screen"
                ref={screenShareRef}
                autoPlay
                muted={screenSharing}
                playsInline
                style={{ width: '100%', height: '100%', objectFit: 'contain' }}
              />
              <div className="screen-label">
                {screenSharing ? '📺 Ekran Paylaşımın' : '📺 Partner Ekran Paylaşımı'}
              </div>
            </div>
          ) : showPartnerAsMain ? (
            <div key="main-partner" className="video-wrapper">
              <video
                key="video-partner"
                ref={remoteVideoRef}
                autoPlay
                playsInline
                muted={false}
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
              <div className="remote-label">Partner Görüntüsü</div>
            </div>
          ) : (
            <div className="empty-state">
              <p>Partner görüntüsü veya ekran paylaşımı bekleniyor...</p>
            </div>
          )}

          <div className="local-cameras">
            {hasScreenSource && !showScreenAsMain && (
              <button
                type="button"
                className="camera-box switchable-mini"
                onClick={() => setMainView('screen')}
                title="Ekranı büyüt"
              >
                <video
                  ref={screenMiniRef}
                  autoPlay
                  muted
                  playsInline
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
                <div className="camera-label">Ekran</div>
              </button>
            )}

            {hasPartnerSource && showScreenAsMain && (
              <button
                type="button"
                className="camera-box switchable-mini"
                onClick={() => setMainView('partner')}
                title="Partneri büyüt"
              >
                <video
                  ref={remoteMiniVideoRef}
                  autoPlay
                  muted={false}
                  playsInline
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
                <div className="camera-label">Partner</div>
              </button>
            )}

            <div className="camera-box local-camera">
              <video
                ref={localVideoRef}
                autoPlay
                muted
                playsInline
                style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }}
              />
              <div className="camera-label">Sen</div>
            </div>
          </div>

          <div className="controls">
            <button
              onClick={toggleCamera}
              className={`btn control-btn ${cameraEnabled ? 'active' : ''}`}
              title="Kamera"
            >
              {cameraEnabled ? '📷' : '🚫'}
            </button>

            <button
              onClick={toggleMicrophone}
              className={`btn control-btn ${micEnabled ? 'active' : ''}`}
              title="Mikrofon"
            >
              {micEnabled ? '🎤' : '🔇'}
            </button>

            <button
              onClick={toggleScreenShare}
              className={`btn control-btn ${screenSharing ? 'active' : ''}`}
              title="Ekran Paylaş"
            >
              🖥
            </button>
          </div>
        </div>

        <div className="users-panel">
          <h3>👥 Katılımcılar ({users.length})</h3>
          <div className="users-list">
            {users.map((user) => (
              <div key={user.id} className="user-item">
                <span className="user-name">{user.username}</span>
                <span className="user-status">
                  {user.camera ? '📷' : '🚫'} {user.microphone ? '🎤' : '🔇'}
                </span>
              </div>
            ))}
          </div>

          <div className="chat-section">
            <h3>💬 Sohbet</h3>
            <div className="chat-messages">
              {messages.length === 0 ? (
                <p className="chat-empty">Henüz mesaj yok. İlk mesajı sen at.</p>
              ) : (
                messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`chat-message ${msg.username === username ? 'own' : ''}`}
                  >
                    <div className="chat-meta">
                      <span className="chat-user">{msg.username}</span>
                      <span className="chat-time">
                        {new Date(msg.createdAt).toLocaleTimeString('tr-TR', {
                          hour: '2-digit',
                          minute: '2-digit'
                        })}
                      </span>
                    </div>
                    <p className="chat-text">{msg.message}</p>
                  </div>
                ))
              )}
            </div>

            <div className="chat-actions">
              <div className="reaction-buttons">
                <button type="button" onClick={() => handleSendReaction('heart')} className="reaction-btn" title="Kalp Gönder">❤️</button>
                <button type="button" onClick={() => handleSendReaction('elif')} className="reaction-btn" title="Elif Gönder">Elif</button>
              </div>
              <form className="chat-form" onSubmit={handleSendMessage}>
                <input
                  type="text"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder="Mesaj yaz..."
                  maxLength={350}
                />
                <button type="submit" className="btn btn-primary chat-send">
                  Gönder
                </button>
              </form>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default App
