package com.megabridge.subwayalert;

import jakarta.servlet.*;
import jakarta.servlet.http.*;
import java.io.IOException;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

@Component
public class SecurityHeaders extends OncePerRequestFilter {
    @Override protected void doFilterInternal(HttpServletRequest req,HttpServletResponse res,FilterChain chain) throws ServletException,IOException {
        res.setHeader("X-Content-Type-Options","nosniff");
        res.setHeader("Referrer-Policy","same-origin");
        res.setHeader("Content-Security-Policy","default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'");
        if(req.getRequestURI().startsWith("/api/")) res.setHeader("Cache-Control","no-store");
        chain.doFilter(req,res);
    }
}
