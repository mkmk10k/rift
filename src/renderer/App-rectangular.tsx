import { useState, useEffect } from 'react'

// Rectangular widget - no rounded corners to match window shape
function App() {
  const [status, setStatus] = useState('Loading...')
  const [showSettings, setShowSettings] = useState(false)
  const [modelReady, setModelReady] = useState(false)

  useEffect(() => {
    if (showSettings) {
      window.outloud?.window?.resize(540, 520);
    } else {
      window.outloud?.window?.resize(420, 96);
    }
  }, [showSettings])

  const checkModels = async () => {
    setStatus('Checking...')
    try {
      if (!window.outloud) {
        setStatus('Initializing...')
        return
      }
      const result = await window.outloud.models.check()
      if (result.available) {
        setStatus('Ready')
        setModelReady(true)
      } else {
        setStatus(result.error?.substring(0, 40) || 'Models unavailable')
        setModelReady(false)
      }
    } catch (error) {
      setStatus('Check failed')
    }
  }

  useEffect(() => {
    const timer = setTimeout(checkModels, 500)
    return () => clearTimeout(timer)
  }, [])

  return (
    <>
      {/* Main Widget - Rectangular to match window */}
      <div style={{
        position: 'fixed',
        top: '0',
        left: '0',
        width: '100%',
        height: '100%',
        background: 'linear-gradient(135deg, rgba(40,40,40,0.85), rgba(30,30,30,0.9))',
        backdropFilter: 'blur(40px) saturate(180%)',
        WebkitBackdropFilter: 'blur(40px) saturate(180%)',
        border: '1px solid rgba(255, 255, 255, 0.3)',
        borderRadius: '0px',  // NO ROUNDED CORNERS
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255,255,255,0.15)',
        padding: '16px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px'
      }}>
        {/* Controls Row */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '14px',
          justifyContent: 'space-between'
        }}>
          {/* Record Button */}
          <button
            className="interactive"
            onClick={() => setStatus('Recording not implemented')}
            style={{
              width: '36px',
              height: '36px',
              borderRadius: '50%',
              background: 'linear-gradient(135deg, #0A84FF 0%, #0066CC 100%)',
              border: '2px solid rgba(255,255,255,0.25)',
              color: 'white',
              fontSize: '22px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 4px 16px rgba(10, 132, 255, 0.4), inset 0 1px 0 rgba(255,255,255,0.3)',
              transition: 'all 0.2s',
              flexShrink: 0
            }}
          >
            ●
          </button>

          {/* Waveform */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '3px', height: '28px', flex: 1 }}>
            {[30, 55, 40, 75, 48, 85, 58, 95, 65, 78, 50, 62].map((height, i) => (
              <div
                key={i}
                style={{
                  width: '5px',
                  height: `${height}%`,
                  background: 'linear-gradient(to top, rgba(255,255,255,0.15), rgba(255,255,255,0.4))',
                  borderRadius: '2.5px',
                  boxShadow: '0 2px 4px rgba(0,0,0,0.2)'
                }}
              />
            ))}
          </div>

          {/* App Name */}
          <div style={{ 
            color: '#FFFFFF', 
            fontSize: '15px', 
            fontWeight: '700',
            letterSpacing: '0.5px',
            minWidth: '90px',
            textAlign: 'center',
            textShadow: '0 2px 8px rgba(0,0,0,0.9), 0 1px 3px rgba(0,0,0,1)',
            flexShrink: 0
          }}>
            Outloud
          </div>

          {/* Play Button */}
          <button
            className="interactive"
            onClick={() => setStatus('TTS test clicked')}
            style={{
              width: '36px',
              height: '36px',
              borderRadius: '50%',
              background: 'linear-gradient(135deg, rgba(255,255,255,0.22), rgba(255,255,255,0.12))',
              border: '1px solid rgba(255,255,255,0.25)',
              color: 'white',
              fontSize: '14px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 2px 8px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.2)',
              transition: 'all 0.2s',
              flexShrink: 0
            }}
          >
            ▶
          </button>

          {/* Settings Button */}
          <button
            className="interactive"
            onClick={() => setShowSettings(!showSettings)}
            style={{
              width: '36px',
              height: '36px',
              borderRadius: '50%',
              background: 'linear-gradient(135deg, rgba(255,255,255,0.22), rgba(255,255,255,0.12))',
              border: '1px solid rgba(255,255,255,0.25)',
              color: 'white',
              fontSize: '16px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 2px 8px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.2)',
              transition: 'all 0.3s',
              flexShrink: 0
            }}
          >
            ⚙
          </button>
        </div>

        {/* Status - Integrated */}
        <div style={{ 
          textAlign: 'center', 
          fontSize: '12px', 
          color: '#FFFFFF',
          fontWeight: '600',
          padding: '4px 0',
          borderTop: '1px solid rgba(255,255,255,0.12)',
          paddingTop: '10px',
          textShadow: '0 2px 6px rgba(0,0,0,0.9), 0 1px 3px rgba(0,0,0,1)'
        }}>
          {status}
        </div>
      </div>

      {/* Settings Panel */}
      {showSettings && (
        <div style={{ 
          position: 'absolute',
          top: '106px',
          left: '0',
          right: '0',
          background: 'linear-gradient(135deg, rgba(45,45,45,0.9), rgba(35,35,35,0.95))',
          backdropFilter: 'blur(40px) saturate(180%)',
          WebkitBackdropFilter: 'blur(40px) saturate(180%)',
          border: '1.5px solid rgba(255, 255, 255, 0.25)',
          borderRadius: '0px',  // NO ROUNDED CORNERS
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255,255,255,0.15)',
          padding: '24px',
          maxHeight: '380px',
          overflowY: 'auto'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px', alignItems: 'center' }}>
            <h3 style={{ 
              color: 'white', 
              fontSize: '18px', 
              fontWeight: '700', 
              margin: 0,
              textShadow: '0 2px 6px rgba(0,0,0,0.8)'
            }}>
              Settings
            </h3>
            <button
              className="interactive"
              onClick={() => setShowSettings(false)}
              style={{
                width: '28px',
                height: '28px',
                borderRadius: '50%',
                background: 'linear-gradient(135deg, rgba(255,255,255,0.2), rgba(255,255,255,0.1))',
                border: '1px solid rgba(255,255,255,0.2)',
                color: 'white',
                fontSize: '20px',
                cursor: 'pointer',
                boxShadow: '0 2px 6px rgba(0,0,0,0.2)'
              }}
            >
              ×
            </button>
          </div>

          <div style={{ color: 'white', fontSize: '14px', lineHeight: '1.8' }}>
            <div style={{ marginBottom: '16px' }}>
              <div style={{ 
                background: 'rgba(0,0,0,0.3)',
                borderRadius: '8px',
                padding: '14px',
                marginBottom: '10px'
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <strong style={{ textShadow: '0 1px 3px rgba(0,0,0,0.8)' }}>Status:</strong> 
                  <span style={{ 
                    color: modelReady ? '#34C759' : '#FF453A',
                    fontWeight: '700',
                    textShadow: '0 1px 3px rgba(0,0,0,0.8)'
                  }}>
                    {modelReady ? '✓ Ready' : '✗ Not Available'}
                  </span>
                </div>
                <div style={{ fontSize: '12px', opacity: 0.9, textShadow: '0 1px 2px rgba(0,0,0,0.8)' }}>
                  {status}
                </div>
              </div>
              <button
                className="interactive"
                onClick={checkModels}
                style={{
                  width: '100%',
                  padding: '12px',
                  background: 'linear-gradient(135deg, rgba(10, 132, 255, 0.35), rgba(10, 132, 255, 0.25))',
                  border: '1px solid rgba(10, 132, 255, 0.5)',
                  borderRadius: '8px',
                  color: 'white',
                  fontSize: '14px',
                  fontWeight: '700',
                  cursor: 'pointer',
                  textShadow: '0 1px 3px rgba(0,0,0,0.8)',
                  boxShadow: '0 2px 8px rgba(10,132,255,0.3)'
                }}
              >
                Refresh Model Status
              </button>
            </div>
            <div style={{ fontSize: '12px', opacity: 0.9, textShadow: '0 1px 2px rgba(0,0,0,0.8)' }}>
              <div style={{ marginBottom: '6px' }}><strong>Shortcuts:</strong></div>
              <div>⌘⇧W - Show/hide widget</div>
              <div>⌘⇧V - Voice dictation (soon)</div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

export default App





