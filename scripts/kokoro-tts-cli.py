#!/usr/bin/env python3
"""Text input file -> Brazilian Portuguese neural TTS MP3 (offline)."""
import argparse, os, re, subprocess, sys
from pathlib import Path
import numpy as np
import soundfile as sf
from misaki.espeak import EspeakG2P
from kokoro_onnx import Kokoro

def chunks(text, limit=180):
    text=re.sub(r'\s+',' ',text).strip()
    phrases=re.split(r'(?<=[.!?;:])\s+',text)
    result=[]
    part=''
    for phrase in phrases:
        words=phrase.split()
        for word in words:
            if len(part)+len(word)+1>limit:
                if part:result.append(part)
                part=word
            else:part=(part+' '+word).strip()
        if part and len(part)>80:
            result.append(part)
            part=''
    if part:result.append(part)
    return result

def run():
    ap=argparse.ArgumentParser()
    ap.add_argument('--text',required=True)
    ap.add_argument('--output',required=True)
    args=ap.parse_args()
    root=Path(__file__).resolve().parents[1]
    model=root/'data/models/kokoro'
    out=Path(args.output).resolve()
    text=Path(args.text).read_text('utf8')
    if len(text)>30000 or len(text)<2:raise ValueError('Tamanho de roteiro inválido')
    for p in [model/'kokoro-v1.0.fp16.onnx',model/'voices-v1.0.bin']:
        if not p.is_file():raise FileNotFoundError('Modelo Kokoro não encontrado')
    g2p=EspeakG2P(language='pt-br')
    k=Kokoro(str(model/'kokoro-v1.0.fp16.onnx'),str(model/'voices-v1.0.bin'))
    portions=[]
    for phrase in chunks(text):
        phonemes,_=g2p(phrase)
        if not phonemes:continue
        audio,sr=k.create(phonemes,'pm_alex',is_phonemes=True,speed=1.04)
        portions.append(np.asarray(audio,dtype=np.float32))
        portions.append(np.zeros(int(.16*sr),dtype=np.float32))
    if not portions:raise RuntimeError('Nenhum áudio neural foi produzido')
    out.parent.mkdir(parents=True,exist_ok=True)
    wav=out.with_suffix('.tmp.wav')
    try:
        sf.write(wav,np.concatenate(portions),sr,subtype='PCM_16')
        ffmpeg=root/'node_modules/ffmpeg-static/ffmpeg'
        subprocess.run([str(ffmpeg),'-hide_banner','-loglevel','error','-y',
          '-i',str(wav),'-ac','1','-ar','24000','-b:a','96k',str(out)],
          check=True,timeout=120)
    finally:wav.unlink(missing_ok=True)
    print('KOKORO_LOCAL_TTS_COMPLETE',out.stat().st_size,flush=True)
if __name__=='__main__':
    try:run()
    except Exception as error:
        print('KOKORO_LOCAL_TTS_FAILED',str(error)[:300],file=sys.stderr)
        sys.exit(1)
