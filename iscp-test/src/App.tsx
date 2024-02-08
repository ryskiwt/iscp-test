import React, { useState, useEffect } from 'react';
import { v4 as uuidv4 } from 'uuid';
import QRCode from 'qrcode.react';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Box from '@mui/material/Box';
import * as iscp from '@aptpod/iscp-ts'

const THIS_PAGE = 'https://ryskiwt.github.io/iscp-test/'
const sleepMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const getNowTimeNano = () => BigInt(Date.now()) * BigInt(1000_000)
const getNowTimeMilli = () => Date.now();
const getRandomBytes = (length: number) => {
  const randomBytes = new Uint8Array(length);
  window.crypto.getRandomValues(randomBytes);
  return randomBytes;
}
function calculateStats(data: number[]): {
  min: number;
  max: number;
  avg: number;
  stddev: number;
} {
  const min = Math.min(...data);
  const max = Math.max(...data);
  const sum = data.reduce((acc, curr) => acc + curr, 0);
  const avg = sum / data.length;
  const variance = data.reduce((acc, curr) => acc + (curr - avg) ** 2, 0) / data.length;
  const stddev = Math.sqrt(variance);
  return { min, max, avg, stddev };
}

interface FormData {
  url: string;
  token: string;
  nodeId: string;
  dataName: string;
  dataType: string;
  payloadSize: string;
  frequency: string;
  limit: string;
  [key: string]: string;
}

const App: React.FC = () => {
    const [formData, setFormData] = useState<FormData>({
      url: '',
      token: '',
      nodeId: '',
      dataName: '',
      dataType: '',
      flushInterval: '',
      payloadSize: '',
      frequency: '',
      limit: '',
    });
    const formLabels: FormData = {
      url: 'intdashサーバーURL (ex. https://example.intdash.jp)',
      token: 'APIトークン',
      nodeId: 'ノードID',
      dataName: 'データ名',
      dataType: 'データタイプ',
      flushInterval: "フラッシュ間隔 [ms]",
      payloadSize: 'ペイロードサイズ [KiB]',
      frequency: '送信頻度 [Hz]',
      limit: '送信回数',
    };
    const [thisPage, setThisPage] = useState(THIS_PAGE);
    const [result, setResult] = useState('');
    const [isLoading, setIsLoading] = useState(false);

    useEffect(() => {
      const searchParams = new URLSearchParams(window.location.search);
      const url = searchParams.get('url') || localStorage.getItem('url') || 'https://example.intdash.jp';
      const token = searchParams.get('token') || localStorage.getItem('token') || '';
      const nodeId = searchParams.get('nodeId') || localStorage.getItem('nodeId') || '';
      const dataName = searchParams.get('dataName') || localStorage.getItem('dataName') || 'data_name';
      const dataType = searchParams.get('dataType') || localStorage.getItem('dataType') || 'bytes';
      const flushInterval = searchParams.get('flushInterval') || localStorage.getItem('flushInterval') || '10';
      const payloadSize = searchParams.get('payloadSize') || localStorage.getItem('payloadSize') || '10';
      const frequency = searchParams.get('frequency') || localStorage.getItem('frequency') || '1000';
      const limit = searchParams.get('limit') || localStorage.getItem('limit') || '1000';
      setFormData({ url, token, nodeId, dataName, dataType, flushInterval, payloadSize, frequency, limit});
      window.history.replaceState(null, '', window.location.pathname);

      const params = new URLSearchParams({url, token, nodeId, dataName, dataType, flushInterval, payloadSize, frequency, limit});
      setThisPage(`${THIS_PAGE}?${params.toString()}`);
    }, []);

    const handleQRCodeClick = () => {
      navigator.clipboard.writeText(thisPage).then(() => {
        alert('URL copied');
      }).catch(err => {
        console.error('URL copy failed', err);
      });
    };

    const handleChange = (e: any) => {
      const { name, value } = e.target;
      setFormData(prevFormData => ({
        ...prevFormData,
        [name]: value,
      }));
      localStorage.setItem(name, value);
      const params = new URLSearchParams(formData);
      setThisPage(`${THIS_PAGE}?${params.toString()}`);
    };

    const startProcess = async () => {
        setIsLoading(true);
        try {
            const tokenSource = async () => {
              const response = await fetch(`${formData.url}/api/iscp/tickets`, {
                  method: 'POST',
                  headers: {'X-Intdash-Token': formData.token},
              });
              if (!response.ok) {
                  throw new Error('Network response was not ok');
              }
              const data = await response.json();
              return data["ticket"];
            }

            const url = new URL(formData.url);
            const enableTLS = url.protocol=="https:";
            const connector = new iscp.WebSocketConnector({enableTLS: enableTLS});

            const conn = await iscp.Conn.connect({
              address: url.hostname,
              connector,
              tokenSource,
              nodeId: formData.nodeId,
            });

            const sessionId = uuidv4();
            const baseTimeNano = getNowTimeNano();
            const baseTimeMilli = Number(baseTimeNano) / 1000000;
            // FIXME: なぜかFailする
            // await conn.sendBaseTime(
            //   new iscp.BaseTime({
            //     name: 'EdgeRTC',
            //     elapsedTime: 0n,
            //     baseTime: baseTimeNano,
            //     priority: 0,
            //     sessionId: sessionId,
            //   }),
            // );

            let flushPolicy = null;
            if (formData.flushInterval=='0') {
              flushPolicy = iscp.FlushPolicy.immediately();
            } else {
              flushPolicy = iscp.FlushPolicy.intervalOnly(Number(formData.flushInterval)/1000.0)
            }

            const upstream = await conn.openUpstream({
              sessionId: sessionId,
              qos: iscp.QOS.UNRELIABLE,
              flushPolicy: flushPolicy,
              persist: false,
              closeSession: true,
            });
            const downstream = await conn.openDownstream({
              filters: [iscp.DownstreamFilter.allFor(formData.nodeId)],
            });

            const limit = Number(formData.limit);
            let txTimeMillis = new Array(limit);
            let rxTimeMillis = new Array(limit);
            let rttMillis = new Array(limit);
            let outputText = '';
            let i = 0;
            downstream.addEventListener(iscp.Downstream.EVENT.CHUNK, (chunk) => {
              if (chunk.upstreamInfo.sessionId != sessionId) {
                return;
              }

              chunk.dataPointGroups.forEach((grp) => {
                grp.dataPoints.forEach((dp) => {
                  const rxTimeMilli = getNowTimeMilli();
                  const txTimeMilli = Number(dp.elapsedTime)/1000000 + baseTimeMilli ;
                  const rttMilli = rxTimeMilli - txTimeMilli;
    
                  rxTimeMillis[i] = rxTimeMilli;
                  txTimeMillis[i] = txTimeMilli;
                  rttMillis[i] = rttMilli;
                  i++;

                  outputText += `${i}: chunk=${chunk.sequenceNumber}, rtt=${rttMilli.toFixed(2)} ms<br/>`;
                  setResult(outputText);
                });
              });

              if (i==limit) {
                const { min, max, avg, stddev } = calculateStats(rttMillis);
                const duration = rxTimeMillis[rxTimeMillis.length-1] - txTimeMillis[0];
                const dataRateMBps = Number(formData.payloadSize) * limit / duration /1024 *1000;
                outputText += '---- statistics ----<br/>'
                outputText += `min/avg/max/sd = ${min.toFixed(2)}/${avg.toFixed(2)}/${max.toFixed(2)}/${stddev.toFixed(2)} ms<br/>`
                outputText += `throughput = ${dataRateMBps.toFixed(2)} MB/s (${(dataRateMBps*8).toFixed(2)} Mbps)<br/>`
                setResult(outputText);
                downstream.close();
              }
            });

            let kurikoshiMilli = 0;
            const interval = Number(1000) / Number(formData.frequency)
            for (let i = 0; i< limit; i++) {
              const now = getNowTimeNano();
              await upstream.writeDataPoints(new iscp.DataId({name: formData.dataName, type: formData.dataType}), [
                new iscp.DataPoint({
                  elapsedTime: now - baseTimeNano,
                  payload: getRandomBytes(Number(formData.payloadSize)*1024),
                }),
              ]);
              const sleepTimeMilli = interval - Number(getNowTimeNano()-now)/1000000 + kurikoshiMilli;
              if (sleepTimeMilli >= 1) {
                await sleepMs(sleepTimeMilli);
              } else {
                kurikoshiMilli = sleepTimeMilli
              }
            }

            await upstream.flush();
            await upstream.close();
            await downstream.waitClosed();
            await conn.close();

        } catch (error) {
            console.log(error);
            setResult('Unexpected Error');

          } finally {
            setIsLoading(false);
        }
    };

    return (
      <Container maxWidth="sm" sx={{ p: 2 }}>
        <Box sx={{ 
          display: 'flex', 
          flexDirection: 'column', 
          alignItems: 'center', 
          justifyContent: 'center', 
          width: '100%',
        }}>
          <Typography variant="h4" component="h1" gutterBottom sx={{ width: '100%', textAlign: 'center', fontWeight: 'bold' }}>
            intdash Protocol Testing Tool
          </Typography>
          <Box onClick={handleQRCodeClick} sx={{ cursor: 'pointer' }}>
            <QRCode value={thisPage} size={128} />
          </Box>
          <Typography sx={{ mt: 2, mb: 2 }}>QRコードからこのページへアクセス可能。クリックでURLコピー</Typography>
          {Object.keys(formData).map((key) => (
            <TextField
              key={key}
              label={formLabels[key]}
              variant="outlined"
              name={key}
              value={formData[key]}
              onChange={handleChange}
              margin="normal"
              InputLabelProps={{
                shrink: true,
              }}
              fullWidth
              sx={{ mb: 1 }}
            />
          ))}
          <Button
            variant="contained"
            color="primary"
            onClick={startProcess}
            disabled={isLoading}
            fullWidth
            sx={{
              mt: 2,
              mb: 2,
              height: 56,
              fontSize: '1.25rem',
            }}
          >
            {isLoading ? <CircularProgress size={24} /> : 'スタート'}
          </Button>
          {result && <Box sx={{ mt: 2, width: '100%', fontSize: '1.25rem',fontFamily: '"Roboto Mono", "Courier New", monospace' }} dangerouslySetInnerHTML={{ __html: result }}></Box>}
        </Box>
      </Container>
    );
};

export default App;
