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
  limit: string;
  interval: string;
  [key: string]: string;
}

const App: React.FC = () => {
    const [formData, setFormData] = useState<FormData>({
      url: '',
      token: '',
      nodeId: '',
      dataName: '',
      dataType: '',
      payloadSize: '',
      limit: '',
      interval: '',
    });
    const formLabels: FormData = {
      url: 'intdash Server URL (ex. https://example.intdash.jp)',
      token: 'API Token',
      nodeId: 'Node ID',
      dataName: 'Data Name',
      dataType: 'Data Type',
      payloadSize: 'Payload Size [B]',
      limit: 'Limit',
      interval: 'Interval [ms]',
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
      const payloadSize = searchParams.get('payloadSize') || localStorage.getItem('payloadSize') || '64';
      const limit = searchParams.get('limit') || localStorage.getItem('limit') || '10';
      const interval = searchParams.get('interval') || localStorage.getItem('interval') || '1000';
      setFormData({ url, token, nodeId, dataName, dataType, payloadSize, limit, interval });
      window.history.replaceState(null, '', window.location.pathname);

      const params = new URLSearchParams({url, token, nodeId, dataName, dataType, payloadSize, limit, interval});
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
            const baseTime = getNowTimeNano();
            // FIXME: なぜかFailする
            // await conn.sendBaseTime(
            //   new iscp.BaseTime({
            //     name: 'EdgeRTC',
            //     elapsedTime: 0n,
            //     baseTime: baseTime,
            //     priority: 0,
            //     sessionId: sessionId,
            //   }),
            // );

            const upstream = await conn.openUpstream({
              sessionId: sessionId,
              qos: iscp.QOS.UNRELIABLE,
              flushPolicy: iscp.FlushPolicy.immediately(),
              persist: false,
            });
            const downstream = await conn.openDownstream({
              filters: [iscp.DownstreamFilter.allFor(formData.nodeId)],
            });

            let rttMillis: number[] = [];
            let outputText = '';
            downstream.addEventListener(iscp.Downstream.EVENT.CHUNK, (chunk) => {
              if (chunk.upstreamInfo.sessionId != sessionId) {
                return;
              }
              const rxTimeNano = getNowTimeNano();
              const txTimeNano = chunk.dataPointGroups[0].dataPoints[0].elapsedTime + baseTime;
              const rttNano = Number(rxTimeNano - txTimeNano);
              const rttMilli = Number(rttNano) / 1000000.0;
              rttMillis.push(rttMilli);
              outputText += `${chunk.sequenceNumber}: rtt=${rttMilli.toFixed(2)} ms<br/>`;
              setResult(outputText);
              if (chunk.sequenceNumber==Number(formData.limit)) {
                const { min, max, avg, stddev } = calculateStats(rttMillis);
                outputText += '---- statistics ----<br/>'
                outputText += `min/avg/max/sd = ${min.toFixed(2)}/${avg.toFixed(2)}/${max.toFixed(2)}/${stddev.toFixed(2)} ms<br/>`
                setResult(outputText);
              }
            });

            for (let i = 0; i < Number(formData.limit); i++) {
              await sleepMs(Number(formData.interval))
              const payload = getRandomBytes(Number(formData.payloadSize));
              await upstream.writeDataPoints(new iscp.DataId({name: formData.dataName, type: formData.dataType}), [
                new iscp.DataPoint({
                  elapsedTime: getNowTimeNano() - baseTime,
                  payload: payload,
                }),
              ]);
            }

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
            iSCP Ping/Pong
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
