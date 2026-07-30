require('dotenv').config();
const express=require('express');
const cors=require('cors');
const app=express();
app.use(cors({origin:'*'}));
app.use(express.json());
app.get('/',(req,res)=>res.json({status:'DAV Backend LIVE!', db:'Neon Ready', paystack:'Ready', time:new Date()}));
app.listen(process.env.PORT||4000,()=>console.log('LIVE'));
