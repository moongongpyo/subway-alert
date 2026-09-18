package com.megabridge.subwayalert;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
public class SubwayAlertApplication {

	public static void main(String[] args) {
		SpringApplication.run(SubwayAlertApplication.class, args);
	}

}
