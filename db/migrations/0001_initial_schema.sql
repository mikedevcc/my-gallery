-- My Gallery application schema baseline, version 0001.
-- Source: mygallery-schema.sql (PostgreSQL 17.7 schema export).
-- Apply only to a fresh database after review; never replay on an existing library.
-- Historical Prisma bookkeeping and dump session/client commands are excluded.
-- Primary-key and UNIQUE constraints create the snapshot's backing indexes.
-- Transaction and stop-on-error behavior are supplied by the invocation in README.md.

CREATE TABLE public.album (
    album_id integer NOT NULL,
    album_name character varying(100) NOT NULL,
    cover_media_id integer
);

ALTER TABLE public.album ALTER COLUMN album_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.album_album_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.city (
    city_id integer NOT NULL,
    city_name character varying(200) NOT NULL,
    country_id integer NOT NULL
);

ALTER TABLE public.city ALTER COLUMN city_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.city_city_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.country (
    country_id integer NOT NULL,
    country_name character varying(150) NOT NULL
);

ALTER TABLE public.country ALTER COLUMN country_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.country_country_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.image (
    media_id integer NOT NULL,
    aperture numeric(4,2),
    iso integer,
    exposure_time numeric(12,8),
    focal_length_mm numeric(6,2),
    focal_length_35mm numeric(6,2),
    flash character varying(50),
    white_balance character varying(50),
    CONSTRAINT image_aperture_check CHECK ((aperture > (0)::numeric)),
    CONSTRAINT image_focal_length_35mm_check CHECK ((focal_length_35mm > (0)::numeric)),
    CONSTRAINT image_focal_length_mm_check CHECK ((focal_length_mm > (0)::numeric)),
    CONSTRAINT image_iso_check CHECK ((iso > 0))
);

CREATE TABLE public.media (
    media_id integer NOT NULL,
    file_name text NOT NULL,
    file_type character(5) NOT NULL,
    file_size bigint,
    path text NOT NULL,
    date_taken timestamp with time zone,
    date_imported timestamp with time zone DEFAULT now() NOT NULL,
    width integer,
    height integer,
    latitude numeric(9,7),
    longitude numeric(10,7),
    city_id integer,
    favorite boolean DEFAULT false NOT NULL,
    trip_id integer,
    CONSTRAINT media_check CHECK ((((latitude IS NULL) AND (longitude IS NULL)) OR ((latitude IS NOT NULL) AND (longitude IS NOT NULL)))),
    CONSTRAINT media_file_size_check CHECK ((file_size > 0)),
    CONSTRAINT media_file_type_check CHECK ((file_type = ANY (ARRAY['IMAGE'::bpchar, 'VIDEO'::bpchar]))),
    CONSTRAINT media_height_check CHECK ((height > 0)),
    CONSTRAINT media_latitude_check CHECK (((latitude >= ('-90'::integer)::numeric) AND (latitude <= (90)::numeric))),
    CONSTRAINT media_longitude_check CHECK (((longitude >= ('-180'::integer)::numeric) AND (longitude <= (180)::numeric))),
    CONSTRAINT media_width_check CHECK ((width > 0))
);

CREATE TABLE public.media_album (
    media_id integer NOT NULL,
    album_id integer NOT NULL,
    date_added timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE public.media ALTER COLUMN media_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.media_media_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.trip (
    trip_id integer NOT NULL,
    trip_name character varying(100) NOT NULL
);

ALTER TABLE public.trip ALTER COLUMN trip_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.trip_trip_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.video (
    media_id integer NOT NULL,
    duration_seconds numeric(12,4),
    frame_rate numeric(8,3),
    video_codec character varying(50),
    audio_codec character varying(50),
    bitrate bigint,
    CONSTRAINT video_bitrate_check CHECK ((bitrate >= 0)),
    CONSTRAINT video_duration_seconds_check CHECK ((duration_seconds >= (0)::numeric)),
    CONSTRAINT video_frame_rate_check CHECK ((frame_rate > (0)::numeric))
);

ALTER TABLE ONLY public.album
    ADD CONSTRAINT album_pkey PRIMARY KEY (album_id);

ALTER TABLE ONLY public.city
    ADD CONSTRAINT city_city_name_country_id_key UNIQUE (city_name, country_id);

ALTER TABLE ONLY public.city
    ADD CONSTRAINT city_pkey PRIMARY KEY (city_id);

ALTER TABLE ONLY public.country
    ADD CONSTRAINT country_country_name_key UNIQUE (country_name);

ALTER TABLE ONLY public.country
    ADD CONSTRAINT country_pkey PRIMARY KEY (country_id);

ALTER TABLE ONLY public.image
    ADD CONSTRAINT image_pkey PRIMARY KEY (media_id);

ALTER TABLE ONLY public.media_album
    ADD CONSTRAINT media_album_pkey PRIMARY KEY (media_id, album_id);

ALTER TABLE ONLY public.media
    ADD CONSTRAINT media_path_key UNIQUE (path);

ALTER TABLE ONLY public.media
    ADD CONSTRAINT media_pkey PRIMARY KEY (media_id);

ALTER TABLE ONLY public.trip
    ADD CONSTRAINT trip_pkey PRIMARY KEY (trip_id);

ALTER TABLE ONLY public.video
    ADD CONSTRAINT video_pkey PRIMARY KEY (media_id);

ALTER TABLE ONLY public.album
    ADD CONSTRAINT album_cover_media_id_fkey FOREIGN KEY (cover_media_id) REFERENCES public.media(media_id) ON DELETE SET NULL;

ALTER TABLE ONLY public.city
    ADD CONSTRAINT city_country_id_fkey FOREIGN KEY (country_id) REFERENCES public.country(country_id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.image
    ADD CONSTRAINT image_media_id_fkey FOREIGN KEY (media_id) REFERENCES public.media(media_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.media_album
    ADD CONSTRAINT media_album_album_id_fkey FOREIGN KEY (album_id) REFERENCES public.album(album_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.media_album
    ADD CONSTRAINT media_album_media_id_fkey FOREIGN KEY (media_id) REFERENCES public.media(media_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.media
    ADD CONSTRAINT media_city_id_fkey FOREIGN KEY (city_id) REFERENCES public.city(city_id) ON DELETE SET NULL;

ALTER TABLE ONLY public.media
    ADD CONSTRAINT media_trip_id_fkey FOREIGN KEY (trip_id) REFERENCES public.trip(trip_id) ON DELETE SET NULL;

ALTER TABLE ONLY public.video
    ADD CONSTRAINT video_media_id_fkey FOREIGN KEY (media_id) REFERENCES public.media(media_id) ON DELETE CASCADE;
